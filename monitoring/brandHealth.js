// Marka bazlı tarama sağlığı. Bir mağaza sitesi yapısını değiştirince ya da bizi engelleyince o markanın TÜM
// hedefleri aynı anda hata vermeye başlar; tek tek hata loglarında bu kolay gözden kaçar. Bu modül aktif
// hedefleri markaya göre toplayıp "sorunlu" markaları işaretler (bkz. queue/worker-process.js 'brand-health'
// işi ve scripts/brand-health.js).
const db = require('../store/db');
const logger = require('../logger');
const { captureMessage } = require('./sentry');

// Bir hedef bu kadar ardışık hatadan sonra "sorunlu" sayılır (devre kesicinin ilk geri çekilmelerinden sonra).
const FAILING_AFTER = 3;
// Bir marka, aktif hedeflerinin en az bu oranı sorunluysa (ve yeterli örnek varsa) "sağlıksız" bildirilir.
const UNHEALTHY_RATIO = 0.5;
// Tek bir hedefin kötü olması markanın sorunu değildir; bu kadar hedeften azında oran hesabı yapılmaz.
const MIN_TARGETS = 3;

async function brandHealth() {
  const { rows } = await db.query(
    `SELECT COALESCE(brand, '(bilinmiyor)') AS brand,
            count(*)::int AS active,
            count(*) FILTER (WHERE consecutive_failures >= $1)::int AS failing,
            count(*) FILTER (WHERE last_check_status IS DISTINCT FROM 'ok' AND last_check_status IS NOT NULL)::int AS last_failed,
            mode() WITHIN GROUP (ORDER BY last_check_status) FILTER (WHERE last_check_status IS DISTINCT FROM 'ok') AS top_error
     FROM tracked_targets
     WHERE active = true
     GROUP BY 1
     ORDER BY 1`,
    [FAILING_AFTER]
  );
  return rows.map((r) => {
    const ratio = r.active > 0 ? r.failing / r.active : 0;
    return {
      brand: r.brand,
      active: r.active,
      failing: r.failing,
      failingRatio: Math.round(ratio * 100) / 100,
      topError: r.top_error,
      unhealthy: r.active >= MIN_TARGETS && ratio >= UNHEALTHY_RATIO,
    };
  });
}

// Periyodik iş: özeti loglar, sağlıksız markalar için ERROR seviyesinde uyarı yazar (log toplayıcı /
// Sentry uyarıları buna bağlanır).
async function reportBrandHealth() {
  const brands = await brandHealth();
  for (const b of brands) {
    if (b.unhealthy) {
      const message = `[health] ${b.brand} sağlıksız: aktif hedeflerin %${Math.round(b.failingRatio * 100)}'i ardışık hata veriyor`;
      logger.error(b, message);
      captureMessage(message, 'error', b); // Sentry açıksa uyarı e-postası/bildirimi buradan doğar
    }
  }
  logger.info({ brands: brands.map((b) => `${b.brand}:${b.failing}/${b.active}`) }, '[health] marka sağlığı');
  return brands;
}

module.exports = { brandHealth, reportBrandHealth, FAILING_AFTER, UNHEALTHY_RATIO, MIN_TARGETS };
