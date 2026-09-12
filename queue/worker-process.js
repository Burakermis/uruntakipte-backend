// Ayrı bir process olarak çalışır (npm run worker) — API sunucusundan
// (server.js) bağımsız. Böylece Playwright/fetch işi API'nin istek-yanıt
// döngüsünü bloklamaz ve concurrency (aynı anda kaç Chromium/istek) burada,
// tek bir yerde sınırlanır.
const { Worker } = require('bullmq');
const { connection } = require('./scrapeQueue');
const { fetchHtml } = require('../scraper/fetchHtml');
const { resolveProductFromHtml } = require('../scraper/registry');
const { normalizeTrackingUrl } = require('../scraper/normalizeUrl');
const trackedTargetStore = require('../store/trackedTargetStore');
const priceHistoryStore = require('../store/priceHistoryStore');
const { checkTrackedTarget } = require('../checker');
const { isTargetDue } = require('../checkSchedule');
const { prewarmBrowser } = require('../scraper/browserFetch');
const htmlCache = require('../store/htmlCache');
const db = require('../store/db');
const logger = require('../logger');

const SCRAPE_CONCURRENCY = 5;
const CHECK_CONCURRENCY = 5;
// Aynı domaine art arda çok hızlı istek atmamak için (Akamai gibi bot
// korumaları bunu şüpheli buluyor) — eskiden worker.js'in sıralı
// for-loop'unda doğal olarak sağlanıyordu, concurrency>1 ile artık burada
// açıkça uygulanması gerekiyor.
const DOMAIN_DELAY_MS = 1500;
const lastRequestAtByHost = new Map();

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDomainSlot(url) {
  const host = hostnameOf(url);
  if (!host) return;
  const lastAt = lastRequestAtByHost.get(host) ?? 0;
  const wait = lastAt + DOMAIN_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAtByHost.set(host, Date.now());
}

// İlk kez görülen bir URL'i çözüp trackedTarget oluşturur — routes/products.js'in
// eski findOrCreateTarget'ının "cache miss" dalının taşınmış hali (bkz.
// scrapeQueue.js'deki açıklama).
async function processScrapeJob(job) {
  const { url, brandId, htmlOverride, urlKey } = job.data;

  // Aynı sayfa saniyeler önce POST /products/resolve tarafından zaten
  // çekilmişti — Redis'teki kopyasını kullanıp ikinci (ve pahalı) taramadan
  // kaçınıyoruz. htmlOverride: istemcinin kendi çektiği HTML (sunucunun
  // engellendiği markalar için) — varsa o öncelikli.
  const cachedHtml = htmlOverride || (await htmlCache.take(urlKey));
  if (cachedHtml) {
    return finishScrapeJob({ url, brandId, urlKey, html: cachedHtml });
  }

  await waitForDomainSlot(url);
  const fetched = await fetchHtml(url, { brandId });
  if (!fetched) {
    return {
      error: {
        status: 502,
        body: { error: 'FETCH_FAILED', message: 'Ürün sayfasına ulaşılamadı, lütfen daha sonra tekrar deneyin.' },
      },
    };
  }

  return finishScrapeJob({ url, brandId, urlKey, html: fetched.html });
}

// HTML nereden gelirse gelsin (taze tarama, resolve önbelleği ya da
// istemcinin gönderdiği) bundan sonrası aynı: parse et, hedefi bul/oluştur.
async function finishScrapeJob({ url, brandId, urlKey, html }) {
  const resolved = resolveProductFromHtml({ url, html });
  if (resolved.error) {
    const status = resolved.error === 'PARSE_FAILED' ? 422 : 500;
    return { error: { status, body: resolved } };
  }

  const canonicalKey = normalizeTrackingUrl(resolved.canonicalUrl || url);
  let target = await trackedTargetStore.findByKey(canonicalKey);
  if (target) {
    await trackedTargetStore.addAliasKey(target.id, urlKey);
    return { targetId: target.id };
  }

  target = await trackedTargetStore.create({
    urlKey,
    brand: brandId,
    url: resolved.canonicalUrl || url,
    productId: resolved.productId,
    name: resolved.name,
    imageUrl: resolved.imageUrl,
    canonicalUrl: resolved.canonicalUrl || url,
    variants: resolved.variants,
    lastCheckedAt: new Date().toISOString(),
    lastCheckStatus: 'ok',
  });
  if (canonicalKey !== urlKey) {
    await trackedTargetStore.addAliasKey(target.id, canonicalKey);
  }

  for (const variant of resolved.variants) {
    await priceHistoryStore.record({
      targetId: target.id,
      sku: variant.sku,
      price: variant.price,
      availability: variant.availability,
    });
  }

  return { targetId: target.id };
}

async function processCheckJob(job) {
  const { targetId } = job.data;
  const target = await trackedTargetStore.findById(targetId);
  if (!target) return { ok: false, reason: 'NOT_FOUND' };

  // Kuyruğa girmiş olmak "hâlâ taranmalı" demek değil. Worker bir süre
  // durursa (deploy, çökme) API her tik'te iş eklemeye devam eder; worker
  // geri geldiğinde bu birikmiş işlerin HEPSİNİ arka arkaya çalıştırır ve
  // aynı ürün saniyeler arayla defalarca taranır — canlı testte 10 dakikalık
  // bir kesintiden sonra 18-20 saniye arayla tekrar eden kontroller
  // gözlendi. Bot koruması açısından en kötü desen tam olarak bu, bu yüzden
  // işi yapmadan hemen önce koşulu bir kez daha doğruluyoruz.
  if (!(await isTargetDue(target))) {
    logger.debug({ targetId }, '[worker-process] bayat kontrol işi atlandı (sırası gelmemiş)');
    return { ok: false, reason: 'NOT_DUE' };
  }

  // Kaç saniye bekleyerek domain sırasına girdiğimiz ile asıl taramanın ne
  // sürdüğü AYRI ölçülüyor: ikisi karışırsa "site mi yavaş, biz mi kendi
  // kuyruğumuzda mı bekliyoruz" ayırt edilemiyor — ölçekleme sınırını
  // (aynı hosta 1,5sn'de bir istek) görmek için gereken sinyal bu.
  const beklemeBasi = Date.now();
  await waitForDomainSlot(target.url);
  const taramaBasi = Date.now();
  const result = await checkTrackedTarget(target);
  logger.info(
    {
      targetId,
      brand: target.brand,
      ok: result.ok,
      reason: result.reason,
      events: result.events ? result.events.length : 0,
      domainWaitMs: taramaBasi - beklemeBasi,
      checkMs: Date.now() - taramaBasi,
    },
    '[worker-process] kontrol tamamlandı'
  );
  return result;
}

// 90 günden eski, fiyat/durumu son kayıttan farklı OLMAYAN (yani "sıkıcı",
// tekrar bilgi taşımayan) ardışık priceHistory kayıtlarını buda — asıl
// değişiklik noktaları (previousPrice'ın dayandığı kayıtlar) korunur.
async function processRetentionJob() {
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT id, target_id, sku, price,
              LAG(price) OVER (PARTITION BY target_id, sku ORDER BY checked_at) AS prev_price,
              checked_at
       FROM price_history
     )
     DELETE FROM price_history
     WHERE id IN (
       SELECT id FROM ranked
       WHERE checked_at < now() - INTERVAL '90 days'
         AND prev_price IS NOT DISTINCT FROM price
     )
     RETURNING id`
  );
  logger.info({ deleted: rows.length }, '[worker-process] retention tamamlandı');
  return { deleted: rows.length };
}

const scrapeWorker = new Worker('scrape', processScrapeJob, { connection, concurrency: SCRAPE_CONCURRENCY });
const checkWorker = new Worker('check', processCheckJob, { connection, concurrency: CHECK_CONCURRENCY });
const retentionWorker = new Worker('retention', processRetentionJob, { connection, concurrency: 1 });

for (const worker of [scrapeWorker, checkWorker, retentionWorker]) {
  worker.on('failed', (job, err) => {
    logger.error({ queue: worker.name, jobId: job?.id, err: err.message }, '[worker-process] job başarısız');
  });
}

logger.info(
  { scrapeConcurrency: SCRAPE_CONCURRENCY, checkConcurrency: CHECK_CONCURRENCY },
  "[worker-process] scrape + check + retention worker'ları başladı"
);

// Gerçek tarama işi bu process'te yapılıyor — Chromium'u ilk job'u bekleyen
// kullanıcıya ödetmemek için şimdiden aç.
prewarmBrowser();

// Bu process'in tek işi periyodik kontrolleri sürdürmek — tek bir yakalanmamış
// promise reddi (Node 21'de varsayılan davranış: process'i öldür) yüzünden
// TÜM takip sisteminin sessizce durması kabul edilemez. Hatayı logluyoruz ki
// kök neden görünsün, ama worker ayakta kalıyor; job seviyesindeki hatalar
// zaten BullMQ'nun 'failed' olayıyla ayrıca raporlanıyor.
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason.message : String(reason) },
    '[worker-process] yakalanmamış promise reddi — worker ayakta tutuluyor'
  );
});

async function shutdown() {
  await Promise.all([scrapeWorker.close(), checkWorker.close(), retentionWorker.close()]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
