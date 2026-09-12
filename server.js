const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const productsRouter = require('./routes/products');
const devicesRouter = require('./routes/devices');
const usersRouter = require('./routes/users');
const webhooksRouter = require('./routes/webhooks');
const { BRANDS } = require('./scraper/registry');
const { startWorker } = require('./worker');
const { closeBrowser, prewarmBrowser } = require('./scraper/browserFetch');
const { WORKER_TICK_MS } = require('./constants');
const db = require('./store/db');
const { retentionQueue } = require('./queue/scrapeQueue');
const { productsLimiter, generalLimiter } = require('./middleware/rateLimit');

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // günde bir kez yeter

const app = express();
app.use(cors());
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: '5mb' })); // HTML gövdesi büyük olabilir (test/dev akışı)
app.use(generalLimiter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, supportedBrands: BRANDS.map((b) => b.id) });
});

// products router özellikle scraping'i tetikleyen (resolve/create) uçları
// içeriyor — genel sınırın üzerine daha sıkı bir ek sınır (bkz.
// middleware/rateLimit.js).
app.use('/api/products', productsLimiter, productsRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/users', usersRouter);
app.use('/webhooks', webhooksRouter);

// Merkezi hata middleware'i — TÜM route'lardan SONRA eklenmeli (Express,
// imzasındaki 4. parametreden bunun bir error handler olduğunu anlıyor).
// Buraya düşen her şey (body-parser'ın bozuk JSON'da attığı next(err) dahil,
// artık middleware/asyncHandler.js sayesinde route'lardaki yakalanmamış
// DB/ağ hataları da) istemciye ASLA err.message/err.stack olarak sızmaz.
// ÖNEMLİ: bu middleware olmadan Express kendi varsayılan hata sayfasına
// düşüyordu — NODE_ENV burada 'production' olarak ayarlı OLMADIĞI için
// (bkz. .env) bu varsayılan sayfa TAM stack trace'i ve sunucunun mutlak
// dosya yollarını (C:\workspace\... gibi) HTML olarak istemciye dönüyordu.
// Gerçek hata sadece sunucu logunda (pino) kalır.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  (req.log || logger).error({ err }, '[server] işlenmemiş istek hatası');

  // body-parser'ın bozuk JSON gövdesinde attığı hata bir İSTEMCİ hatasıdır
  // (400) — geri kalan her şey sunucu tarafı kabul edilip 500'e genelleniyor.
  const isBadRequest = err.type === 'entity.parse.failed' || err.status === 400;
  const status = isBadRequest ? 400 : 500;
  const body = isBadRequest
    ? { error: 'INVALID_REQUEST', message: 'İstek gövdesi okunamadı.' }
    : { error: 'INTERNAL_ERROR', message: 'Sunucuda beklenmeyen bir hata oluştu, lütfen daha sonra tekrar deneyin.' };
  res.status(status).json(body);
});

const PORT = process.env.PORT || 4000;

if (require.main === module) {
  (async () => {
    // Şema idempotent (CREATE TABLE IF NOT EXISTS) — her açılışta çalıştırmak
    // güvenli, ayrı bir migration adımı gerektirmiyor (bkz. store/db.js).
    await db.migrate();

    app.listen(PORT, () => {
      logger.info({ port: PORT, brands: BRANDS.map((b) => b.id) }, 'API çalışıyor');
    });
    // Tik süresi artık env'den ayarlanabilir bir "kontrol aralığı" değil —
    // en hızlı tier'a (premium, 1dk) eşit sabit bir taban (bkz. constants.js
    // WORKER_TICK_MS, worker.js). Bunu env ile büyütülebilir bırakmak,
    // birinin "prod'da sakin olsun" diye 5dk'ya çekip premium'un 1dk
    // vaadini sessizce bozmasına kapı aralardı.
    startWorker(WORKER_TICK_MS);

    // POST /products/resolve bu process'te sayfa çekiyor (kuyruğa düşmüyor) —
    // ilk ürün ekleyen kullanıcı Chromium'un açılmasını beklemesin.
    prewarmBrowser();

    // Tekrarlayan (repeat) job — BullMQ aynı repeat seçenekleriyle eklenen
    // job'u tekilleştirir, her sunucu yeniden başlatmasında yeniden
    // eklemek zararsız (yinelenmiyor).
    await retentionQueue.add('prune-price-history', {}, { repeat: { every: RETENTION_INTERVAL_MS } });
  })();

  // Chromium arka planda açık kalmasın diye process kapanırken temizle.
  const shutdown = async () => {
    await closeBrowser();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Yukarıdaki middleware/asyncHandler.js + global error handler her route'u
  // kapsıyor olmalı, ama bu ikinci bir güvenlik ağı: gözden kaçan bir yer
  // (ör. bir route dışı arka plan promise'i) yakalanmamış kalırsa Node
  // 21'in varsayılan davranışı process'i ÖLDÜRMEK — tüm API'nin sessizce
  // çökmesi (bkz. queue/worker-process.js'deki aynı gerekçe/desen, o
  // process için zaten bu şekilde çözülmüştü, burada eksikti).
  process.on('unhandledRejection', (reason) => {
    logger.error(
      { err: reason instanceof Error ? reason.message : String(reason) },
      '[server] yakalanmamış promise reddi — süreç ayakta tutuluyor'
    );
  });
}

module.exports = app;
