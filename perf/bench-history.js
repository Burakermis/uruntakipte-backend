// price_history büyümesi, "önceki fiyat" sorgusunun gecikmesi ve gece temizliği.
// Her kontrol her varyant için satır yazıyordu (bkz. checker.js); premium bir
// hedef günde 1440 kez kontrol ediliyor. GERÇEKÇİ ölçüm için tabloda tek
// hedef değil, zamanda iç içe geçmiş çok sayıda hedefin satırı var
// (planlayıcı tek hedefli sentetik veride farklı bir plan seçip yanıltıyor).
//
// Kullanım: DATABASE_URL=postgres://.../trackprice_perf node perf/bench-history.js [1000,20000,130000]
//   HISTORY_BG_TARGETS (varsayılan 50) x HISTORY_BG_ROWS (varsayılan 10000) x 4 sku arka plan satırı.
const { db, reset, seedUsers, seedTargets, round, summarize } = require('./lib');
const priceHistoryStore = require('../store/priceHistoryStore');

async function timeMs(fn, runs = 15) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return summarize(times);
}

async function main() {
  const scales = (process.argv[2] || '1000,20000,130000').split(',').map(Number);
  const bgTargets = Number(process.env.HISTORY_BG_TARGETS || 50);
  const bgRows = Number(process.env.HISTORY_BG_ROWS || 10000);
  await reset();
  await seedUsers(10, 0);
  await seedTargets(bgTargets);

  console.log(`arka plan: ${bgTargets} hedef x 4 sku x ${bgRows} satır (zamanda iç içe) yükleniyor...`);
  await db.query(
    `INSERT INTO price_history (target_id, sku, price, availability, checked_at)
     SELECT t.id, 'bg-' || s, 100 + ((g / 3000) % 3) * 10, 'in_stock', now() - (g || ' minutes')::interval
     FROM tracked_targets t CROSS JOIN generate_series(1, 4) s CROSS JOIN generate_series(1, $1::int) g`,
    [bgRows]
  );
  const targetId = Number((await db.query('SELECT min(id) AS id FROM tracked_targets')).rows[0].id);
  await db.query('ANALYZE price_history');

  const bg = await timeMs(() => priceHistoryStore.previousPrice(targetId, 'bg-1', 100));
  console.log(`tipik (hedef,sku) çifti (${bgRows} satır): previousPrice p50 ${round(bg.p50, 2)} ms, p95 ${round(bg.p95, 2)} ms\n`);

  console.log('ağır (hedef,sku) çifti satırı   previousPrice p50 / p95 (ms)   plan');
  let have = 0;
  for (const rows of scales) {
    await db.query(
      `INSERT INTO price_history (target_id, sku, price, availability, checked_at)
       SELECT $1::int, 'perf-sku', 100 + ((g / 5000) % 3) * 10, 'in_stock', now() - (g || ' minutes')::interval
       FROM generate_series($2::int, $3::int) g`,
      [targetId, have + 1, rows]
    );
    have = rows;
    await db.query('ANALYZE price_history');
    const stat = await timeMs(() => priceHistoryStore.previousPrice(targetId, 'perf-sku', 100));
    const plan = await db.query(
      `EXPLAIN (ANALYZE, FORMAT TEXT)
       SELECT price FROM (SELECT price, checked_at FROM price_history WHERE target_id = $1 AND sku = 'perf-sku' ORDER BY checked_at DESC LIMIT 50) recent
       WHERE price IS DISTINCT FROM 100 ORDER BY checked_at DESC LIMIT 1`,
      [targetId]
    );
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    const idx = (text.match(/Index (?:Only )?Scan (?:Backward )?using (\w+)/) || [])[1];
    const kind = /Sort/.test(text) ? 'Sort — çiftin tüm satırları okunup sıralanıyor' : idx ? `Index Scan (${idx})` : 'diğer';
    console.log(`${String(rows).padStart(28)}   ${String(round(stat.p50, 2)).padStart(8)} / ${String(round(stat.p95, 2)).padEnd(8)}   ${kind}`);
  }

  // Tek kontrolün yazma maliyeti. ESKİ yol: her varyant için ayrı INSERT (sıralı) ve
  // HER kontrolde. YENİ yol (checker.js): yalnızca değişen varyantlar, tek toplu INSERT.
  const variants = 12; // Zara: 3 renk x 4 beden
  const perCheckOld = await timeMs(async () => {
    for (let v = 0; v < variants; v++) {
      await priceHistoryStore.record({ targetId, sku: `perf-w-${v}`, price: 100, availability: 'in_stock' });
    }
  }, 30);
  const batchRows = Array.from({ length: variants }, (_, v) => ({ sku: `perf-b-${v}`, price: 100, availability: 'in_stock' }));
  const perCheckNew = await timeMs(() => priceHistoryStore.recordMany(targetId, batchRows), 30);
  console.log(`\n${variants} varyantlı bir kontrolün yazımı: eski (12 ayrı INSERT) p50 ${round(perCheckOld.p50, 1)} ms | toplu tek INSERT p50 ${round(perCheckNew.p50, 1)} ms | değişim yoksa 0 satır, 0 sorgu`);

  // Büyüme modeli — ölçülen satır boyutuyla.
  const size = (await db.query(`SELECT pg_total_relation_size('price_history') AS bytes, (SELECT count(*) FROM price_history) AS rows`)).rows[0];
  const bytesPerRow = Number(size.bytes) / Number(size.rows);
  console.log(`\nölçülen: ${round(bytesPerRow)} bayt/satır (tablo+indeks), toplam ${(Number(size.rows) / 1e6).toFixed(2)} M satır`);
  console.log('büyüme modeli, premium (1440 kontrol/gün), 12 varyant:');
  const changesPerDay = Number(process.env.HISTORY_CHANGES_PER_DAY || 2); // VARSAYIM: hedef başına günde kaç değişim olayı
  const changedVariants = Number(process.env.HISTORY_CHANGED_VARIANTS || 4); // VARSAYIM: bir olayda kaç varyant değişiyor
  for (const targets of [10, 100, 1000]) {
    const oldPerDay = targets * variants * 1440;
    const newPerDay = targets * changesPerDay * changedVariants;
    console.log(
      `  ${String(targets).padStart(5)} premium hedef -> ESKİ ${(oldPerDay / 1e6).toFixed(2)} M satır/gün (90 günde ${((oldPerDay * 90 * bytesPerRow) / 1e9).toFixed(0)} GB) | ` +
        `YENİ ${(newPerDay / 1e3).toFixed(1)} bin satır/gün (90 günde ${((newPerDay * 90 * bytesPerRow) / 1e6).toFixed(0)} MB) [varsayım: günde ${changesPerDay} değişim x ${changedVariants} varyant]`
    );
  }

  // Gece temizliği: tablonun TAMAMI üzerinde pencere fonksiyonu. 1 günden eskileri buda
  // (varsayılan 90 gün yerine, veriyi silecek kadar eski satır olsun diye).
  const t0 = process.hrtime.bigint();
  const deleted = await priceHistoryStore.pruneUnchanged(1);
  const pruneMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`\ngece temizliği (pruneUnchanged): ${(Number(size.rows) / 1e6).toFixed(2)} M satırlık tabloda ${round(pruneMs / 1000, 1)} sn, ${deleted} satır silindi`);

  await db.pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
