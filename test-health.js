// Tarama hatası izleme (izole test DB'si + Redis gerekir): kalıcı hatada kullanıcıya BİR KEZ uyarı ve marka sağlığı raporu.
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const { db, reset } = require('./perf/lib');

// Sayfa çekimi test tarafından sürülür: 'fail' -> FETCH_FAILED, 'ok' -> fixture. checker yüklenmeden ÖNCE değiştirilir.
const MANGO_URL = 'https://shop.mango.com/tr/tr/p/erkek/ceket/ceket/fitilli-kadife-yakalı-denim-ceket/37084403/30/00';
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/mango-denim-ceket.html'), 'utf8');
let mode = 'fail';
require('./scraper/fetchHtml').fetchHtml = async () => (mode === 'ok' ? { html: FIXTURE, source: 'test' } : null);
// Push Redis'e/Expo'ya gitmesin: kullanıcıların cihaz kaydı yok (NO_DEVICE) ama yine de kuyruk sahtelenir.
require('./queue/scrapeQueue').receiptQueue.add = async () => {};
const { checkTrackedTarget } = require('./checker');
const { resolveProductFromHtml } = require('./scraper/registry');
const trackedTargetStore = require('./store/trackedTargetStore');
const subscriptionStore = require('./store/subscriptionStore');
const notificationStore = require('./store/notificationStore');
const { brandHealth, reportBrandHealth, FAILING_AFTER } = require('./monitoring/brandHealth');
const { FAILURE_NOTIFY_THRESHOLD } = require('./constants');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}
const fresh = (id) => trackedTargetStore.findById(id);
const types = async (userId) => (await notificationStore.listByUser(userId)).map((n) => n.type);

(async () => {
  await reset();
  const resolved = resolveProductFromHtml({ url: MANGO_URL, html: FIXTURE });
  const target = await trackedTargetStore.create({
    urlKey: 'h-1', brand: 'mango', url: MANGO_URL, name: 'Denim Ceket', canonicalUrl: resolved.canonicalUrl,
    variants: resolved.variants.map((v) => ({ ...v })),
  });
  await subscriptionStore.create({ userId: 'u1', targetId: target.id, sku: resolved.variants[0].sku, notifyOnPriceDrop: true });
  await subscriptionStore.create({ userId: 'u2', targetId: target.id, sku: resolved.variants[0].sku, notifyOnPriceDrop: true });
  const removedSub = await subscriptionStore.create({ userId: 'u3', targetId: target.id, sku: resolved.variants[0].sku, notifyOnPriceDrop: true });
  await subscriptionStore.remove(removedSub.id); // takipten çıkmış kullanıcı uyarılmamalı

  console.log(`--- 1) eşik: ${FAILURE_NOTIFY_THRESHOLD} ardışık hata`);
  check('eşik 10', FAILURE_NOTIFY_THRESHOLD, 10);
  for (let i = 1; i < FAILURE_NOTIFY_THRESHOLD; i++) await checkTrackedTarget(await fresh(target.id));
  let t = await fresh(target.id);
  check(`${FAILURE_NOTIFY_THRESHOLD - 1} hata: sayaç, durum, HENÜZ uyarı yok`, [t.consecutiveFailures, t.lastCheckStatus, t.failureNotifiedAt, await types('u1')], [FAILURE_NOTIFY_THRESHOLD - 1, 'FETCH_FAILED', null, []]);

  console.log('\n--- 2) eşiğe ulaşınca takipçilere BİR KEZ "takip edilemiyor" gider');
  const r = await checkTrackedTarget(await fresh(target.id));
  check('tarama başarısız döner', [r.ok, r.reason], [false, 'FETCH_FAILED']);
  t = await fresh(target.id);
  check('uyarı zamanı işaretlendi', [t.consecutiveFailures, t.failureNotifiedAt !== null], [FAILURE_NOTIFY_THRESHOLD, true]);
  const n1 = (await notificationStore.listByUser('u1'))[0];
  check('u1 ve u2 uyarıldı; çıkmış u3 uyarılmadı', [await types('u1'), await types('u2'), await types('u3')], [['tracking_failed'], ['tracking_failed'], []]);
  check('metin: ürün adı + açıklama; ürün bağlantısı taşır', [n1.title, n1.body.includes('Mağaza sayfasına'), n1.productUrl], ['Denim Ceket takip edilemiyor', true, resolved.canonicalUrl]);

  console.log('\n--- 3) ısrarlı hatada yinelenmez');
  for (let i = 0; i < 4; i++) await checkTrackedTarget(await fresh(target.id));
  check('4 hata daha: hâlâ tek uyarı', [await types('u1'), (await fresh(target.id)).consecutiveFailures], [['tracking_failed'], FAILURE_NOTIFY_THRESHOLD + 4]);

  console.log('\n--- 4) düzelince sıfırlanır; yeniden bozulursa tekrar uyarılır');
  mode = 'ok';
  const good = await checkTrackedTarget(await fresh(target.id));
  t = await fresh(target.id);
  check('başarılı tarama: sayaç ve uyarı işareti sıfırlandı', [good.ok, t.consecutiveFailures, t.failureNotifiedAt, t.lastCheckStatus], [true, 0, null, 'ok']);
  mode = 'fail';
  for (let i = 0; i < FAILURE_NOTIFY_THRESHOLD; i++) await checkTrackedTarget(await fresh(target.id));
  check('yeniden bozulunca 2. uyarı', await types('u1'), ['tracking_failed', 'tracking_failed']);

  console.log('\n--- 5) marka sağlığı');
  await reset();
  const mk = (n, brand, failures, status = 'FETCH_FAILED', active = true) =>
    trackedTargetStore.create({ urlKey: `b-${n}`, brand, url: `https://x.com/${n}`, name: n, variants: [] }).then((tt) =>
      trackedTargetStore.update(tt.id, { consecutiveFailures: failures, lastCheckStatus: failures ? status : 'ok', active })
    );
  // zara: 4 hedefin 3'ü sorunlu (%75) -> sağlıksız · mango: 4'te 1 (%25) -> sağlıklı · hm: 2 hedef, ikisi de bozuk ama örnek az
  for (const [i, f] of [[1, 5], [2, 9], [3, FAILING_AFTER], [4, 0]]) await mk(`z${i}`, 'zara', f, 'PARSE_FAILED');
  for (const [i, f] of [[1, 6], [2, 0], [3, 0], [4, 0]]) await mk(`m${i}`, 'mango', f);
  for (const i of [1, 2]) await mk(`h${i}`, 'hm', 7);
  await mk('pasif', 'zara', 50, 'FETCH_FAILED', false); // pasif hedef sayılmaz
  const health = Object.fromEntries((await brandHealth()).map((b) => [b.brand, b]));
  check('zara: 4 aktif, 3 sorunlu (eşik dahil), pasif sayılmadı, SAĞLIKSIZ', [health.zara.active, health.zara.failing, health.zara.unhealthy, health.zara.topError], [4, 3, true, 'PARSE_FAILED']);
  check('mango: %25 -> sağlıklı', [health.mango.failing, health.mango.failingRatio, health.mango.unhealthy], [1, 0.25, false]);
  check('hm: örnek az (2 < 3 hedef) -> oran yüksek olsa da sağlıksız İŞARETLENMEZ', [health.hm.active, health.hm.failingRatio, health.hm.unhealthy], [2, 1, false]);
  const reported = await reportBrandHealth();
  check('rapor: yalnızca zara sağlıksız', reported.filter((b) => b.unhealthy).map((b) => b.brand), ['zara']);

  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
