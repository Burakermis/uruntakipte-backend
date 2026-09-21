// Gerçek Postgres'e karşı (izole test DB'si: DATABASE_URL adı perf/e2e/test içermeli, tablolar
// TRUNCATE edilir). filterDueTargets (tik için TOPLU karar) ile isTargetDue (worker'ın işi
// başlatmadan önce yaptığı TEK hedef kararı) ve beklenen değerler aynı sonucu vermeli — ikisi
// ayrışırsa tik kuyruğa atar, worker "NOT_DUE" diye reddeder (ya da tersi: hedef hiç taranmaz).
const { db, reset } = require('./perf/lib');
const trackedTargetStore = require('./store/trackedTargetStore');
const subscriptionStore = require('./store/subscriptionStore');
const userStore = require('./store/userStore');
const { isTargetDue, filterDueTargets } = require('./checkSchedule');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

const NOW = Date.now();
const ago = (sec) => (sec == null ? null : new Date(NOW - sec * 1000).toISOString());

async function makeTarget(name, { lastAttemptSecAgo, lastCheckedSecAgo, failures = 0, subs }) {
  const t = await trackedTargetStore.create({ urlKey: `sched-${name}`, brand: 'zara', url: `https://www.zara.com/${name}-p1.html`, name, variants: [] });
  await db.query(
    'UPDATE tracked_targets SET last_attempt_at = $2, last_checked_at = $3, consecutive_failures = $4 WHERE id = $1',
    [t.id, ago(lastAttemptSecAgo), ago(lastCheckedSecAgo), failures]
  );
  for (const s of subs) {
    await subscriptionStore.create({ userId: s.user, targetId: t.id, sku: 's', active: s.active !== false });
  }
  return t.id;
}

(async () => {
  await reset();
  await userStore.setPremium('prem', true);
  await userStore.setPremium('free', false);
  // 'ghost' için users satırı YOK — ücretsiz sayılmalı.

  const cases = [
    // [ad, ayarlar, beklenen due]
    ['ucretsiz-4dk40sn-once', { lastAttemptSecAgo: 280, subs: [{ user: 'free' }] }, true], // 300-30 tolerans = 270
    ['ucretsiz-4dk-once', { lastAttemptSecAgo: 240, subs: [{ user: 'free' }] }, false],
    ['premium-40sn-once', { lastAttemptSecAgo: 40, subs: [{ user: 'prem' }] }, true], // 60-30 = 30
    ['premium-20sn-once', { lastAttemptSecAgo: 20, subs: [{ user: 'prem' }] }, false],
    ['karma-ucretsiz+premium-40sn', { lastAttemptSecAgo: 40, subs: [{ user: 'free' }, { user: 'prem' }] }, true], // premium aralığı uygulanır
    ['kayitsiz-kullanici-ucretsiz-sayilir-100sn', { lastAttemptSecAgo: 100, subs: [{ user: 'ghost' }] }, false],
    ['pasif-premium-abone-yok-sayilir', { lastAttemptSecAgo: 100, subs: [{ user: 'prem', active: false }, { user: 'free' }] }, false],
    ['hic-denenmemis', { lastAttemptSecAgo: null, lastCheckedSecAgo: null, subs: [{ user: 'free' }] }, true],
    ['sadece-last-checked-var-premium-40sn', { lastAttemptSecAgo: null, lastCheckedSecAgo: 40, subs: [{ user: 'prem' }] }, true],
    ['abonesiz-hedef-denenmis', { lastAttemptSecAgo: 100000, subs: [] }, false], // taban sonsuz
    ['devre-kesici-premium-2-hata-200sn', { lastAttemptSecAgo: 200, failures: 2, subs: [{ user: 'prem' }] }, false], // 60*4=240-30=210
    ['devre-kesici-premium-2-hata-220sn', { lastAttemptSecAgo: 220, failures: 2, subs: [{ user: 'prem' }] }, true],
    ['devre-kesici-tavan-cok-eski', { lastAttemptSecAgo: 7 * 3600, failures: 20, subs: [{ user: 'free' }] }, true], // 6 saat tavan
  ];

  const ids = {};
  for (const [name, cfg] of cases) ids[name] = await makeTarget(name, cfg);

  const all = await trackedTargetStore.listActive();
  const batchDue = new Set((await filterDueTargets(all, NOW)).map((t) => t.id));

  for (const [name, , expected] of cases) {
    const target = all.find((t) => t.id === ids[name]);
    const single = await isTargetDue(target, NOW);
    check(`${name}: toplu`, batchDue.has(ids[name]), expected);
    check(`${name}: tekil ile AYNI`, single, batchDue.has(ids[name]));
  }

  // Toplu karar hedef sayısından bağımsız sorgu sayısıyla çalışmalı.
  const { withQueryCount } = require('./perf/lib');
  const { queries } = await withQueryCount(() => filterDueTargets(all, NOW));
  check('toplu karar: hedef sayısından bağımsız tek sorgu', queries, 1);

  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
