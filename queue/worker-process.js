// Ayrı bir process olarak çalışır (npm run worker) — API sunucusundan
// (server.js) bağımsız. Böylece Playwright/fetch işi API'nin istek-yanıt
// döngüsünü bloklamaz ve concurrency (aynı anda kaç Chromium/istek) burada,
// tek bir yerde sınırlanır.
const { Worker } = require('bullmq');
const { connection } = require('./scrapeQueue');
const { createDomainLimiter } = require('./domainLimiter');
const { fetchHtml } = require('../scraper/fetchHtml');
const { resolveProductFromHtml } = require('../scraper/registry');
const { normalizeTrackingUrl } = require('../scraper/normalizeUrl');
const trackedTargetStore = require('../store/trackedTargetStore');
const priceHistoryStore = require('../store/priceHistoryStore');
const { checkTrackedTarget } = require('../checker');
const { isTargetDue } = require('../checkSchedule');
const { prewarmBrowser } = require('../scraper/browserFetch');
const htmlCache = require('../store/htmlCache');
const logger = require('../logger');

// Varsayılan 5. ÖLÇÜM (perf/bench-worker.js, gerçekçi marka karışımı, alan-adı
// aralığı ZORLANIRKEN): 5 slotla tek worker ~105 kontrol/dk, 10 slotla ~130.
// 10 slotta tavanı slot değil ALAN ADI belirliyor: tek IP'den marka başına
// 1,5sn aralık = en fazla 40 kontrol/dk/marka, yani en kalabalık marka (Zara,
// %30 pay) toplamı ~133/dk'ya kilitliyor. Bir marka 40'tan fazla premium hedef
// taşırsa o markanın 1dk'lık aralığı tutulamaz. Slotu artırmak bunu çözmez;
// çıkış IP'sini çeşitlendirmek (aralığı marka+proxy başına tutmak) gerekir.
// browserFetch'in BROWSER_CONCURRENCY sınırı slotla birlikte artırılmalı.
const SCRAPE_CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY || 5);
const CHECK_CONCURRENCY = Number(process.env.CHECK_CONCURRENCY || 5);
// Aynı domaine art arda çok hızlı istek atmamak için (bkz. domainLimiter.js).
// Süreç BAŞINA: birden çok worker süreci aynı markaya toplamda daha sık istek atar.
const DOMAIN_DELAY_MS = 1500;
const domainLimiter = createDomainLimiter(DOMAIN_DELAY_MS);
const waitForDomainSlot = (url) => domainLimiter.waitForSlot(url);

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

  // İlk kayıt: tüm varyantlar için başlangıç satırı (sonraki kontroller
  // yalnızca değişimi yazar, bkz. checker.js).
  await priceHistoryStore.recordMany(target.id, resolved.variants);

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

  // Yukarıdaki kontrol "okuma"; tarama ise saniyeler sonra ve last_attempt_at
  // ancak tarama BİTİNCE yazılıyor. concurrency>1 iken aynı hedefin birikmiş
  // 2-3 işi aynı anda "sırası geldi" görüp hepsi tarıyordu (canlı testte 3 sn
  // içinde aynı ürün 3 kez). Taramaya başlamadan hedefi atomik olarak
  // sahipleniyoruz: yalnızca ilk iş kazanır.
  if (!(await trackedTargetStore.claimAttempt(target))) {
    logger.debug({ targetId }, '[worker-process] kontrol işi atlandı (hedefi başka bir iş sahiplendi)');
    return { ok: false, reason: 'ALREADY_CLAIMED' };
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

// 90 günden eski, fiyat/durumu son kayıttan farklı OLMAYAN ardışık priceHistory
// kayıtlarını buda (bkz. priceHistoryStore.pruneUnchanged).
async function processRetentionJob() {
  const deleted = await priceHistoryStore.pruneUnchanged(90);
  logger.info({ deleted }, '[worker-process] retention tamamlandı');
  return { deleted };
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
