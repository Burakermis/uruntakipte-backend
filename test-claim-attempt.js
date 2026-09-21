// Gerçek Postgres'e karşı (DATABASE_URL) — birikmiş check işlerinin aynı hedefi
// arka arkaya taramasını engelleyen sahiplenme (bkz. store/trackedTargetStore.js
// claimAttempt, queue/worker-process.js). Kendi satırını oluşturup siler.
const { assertScratchDb } = require('./perf/lib');
assertScratchDb(); // kendi satırını silse de şemayı migrate eder — yalnızca izole test DB'sine karşı çalışsın
const db = require('./store/db');
const trackedTargetStore = require('./store/trackedTargetStore');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

async function raceClaims(id, workers) {
  // Gerçek senaryo: hepsi hedefi "sırası geldi" diye AYNI eski değerle okur
  // (isTargetDue), ancak sonra sahiplenmeyi dener. Okumalar, herhangi bir
  // sahiplenmeden ÖNCE bitmeli — aksi halde geç okuyan iş taze değeri görür
  // ve (gerçekte NOT_DUE alacağı için) doğru olarak kazanmış sayılırdı.
  const snapshots = await Promise.all(Array.from({ length: workers }, () => trackedTargetStore.findById(id)));
  const results = await Promise.all(snapshots.map((target) => trackedTargetStore.claimAttempt(target)));
  return results.filter(Boolean).length;
}

(async () => {
  await db.migrate();
  const target = await trackedTargetStore.create({
    urlKey: `test-claim-${Date.now()}`,
    brand: 'zara',
    url: 'https://www.zara.com/tr/tr/test-p00000000.html',
    name: 'claim testi',
    variants: [],
  });

  try {
    check('hiç denenmemiş hedef (last_attempt_at NULL): 5 eşzamanlı iş -> 1 kazanan', await raceClaims(target.id, 5), 1);
    check('deneme zamanı yazıldı', (await trackedTargetStore.findById(target.id)).lastAttemptAt !== null, true);
    check('ikinci tur: 5 eşzamanlı iş -> yine 1 kazanan', await raceClaims(target.id, 5), 1);

    // Bayat okuma: başkası sahiplendikten sonra eski nesneyle denemek reddedilmeli.
    const stale = await trackedTargetStore.findById(target.id);
    await trackedTargetStore.claimAttempt(stale);
    check('bayat okumayla sahiplenme reddedilir', await trackedTargetStore.claimAttempt(stale), false);

    // Postgres mikrosaniye tutar, JS milisaniye — eşitlik yine de tutmalı.
    await db.query(`UPDATE tracked_targets SET last_attempt_at = '2026-01-01 10:00:00.123456+00' WHERE id = $1`, [target.id]);
    const withMicros = await trackedTargetStore.findById(target.id);
    check('mikrosaniyeli değerle sahiplenme çalışır', await trackedTargetStore.claimAttempt(withMicros), true);
  } finally {
    await db.query('DELETE FROM tracked_targets WHERE id = $1', [target.id]);
    await db.pool.end();
  }

  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
