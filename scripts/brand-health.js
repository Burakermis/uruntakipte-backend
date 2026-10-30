// Marka bazlı tarama sağlığı raporu (bkz. monitoring/brandHealth.js). Kullanım:
//   DATABASE_URL=postgres://... node scripts/brand-health.js
const { brandHealth } = require('../monitoring/brandHealth');
const db = require('../store/db');

(async () => {
  const rows = await brandHealth();
  if (rows.length === 0) console.log('Aktif hedef yok.');
  console.log('marka'.padEnd(16) + 'aktif'.padStart(7) + 'sorunlu'.padStart(9) + 'oran'.padStart(7) + '  en sık hata   durum');
  for (const r of rows) {
    console.log(
      r.brand.padEnd(16) +
        String(r.active).padStart(7) +
        String(r.failing).padStart(9) +
        `${Math.round(r.failingRatio * 100)}%`.padStart(7) +
        `  ${(r.topError || '-').padEnd(14)}${r.unhealthy ? 'SAĞLIKSIZ' : 'ok'}`
    );
  }
  await db.pool.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
