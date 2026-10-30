// Bildirim geçmişi (izole test DB'si + Redis gerekir): kayıt, üst sınır, otomatik temizlik, API ve hesap silme.
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'test-secret-test-secret-test-secret-1234';
const fs = require('fs');
const path = require('path');
const { db, reset } = require('./perf/lib');

// checker yüklenmeden ÖNCE sayfa çekimini fixture ile değiştir (canlı siteye istek yok).
const MANGO_URL = 'https://shop.mango.com/tr/tr/p/erkek/ceket/ceket/fitilli-kadife-yakalı-denim-ceket/37084403/30/00';
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/mango-denim-ceket.html'), 'utf8');
require('./scraper/fetchHtml').fetchHtml = async () => ({ html: FIXTURE, source: 'test' });
const { checkTrackedTarget } = require('./checker');
const { resolveProductFromHtml } = require('./scraper/registry');
const app = require('./server');
const notificationStore = require('./store/notificationStore');
const trackedTargetStore = require('./store/trackedTargetStore');
const subscriptionStore = require('./store/subscriptionStore');
const userStore = require('./store/userStore');
const { NOTIFICATION_RETENTION_DAYS, NOTIFICATION_MAX_PER_USER } = require('./constants');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}
const count = (userId) => db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [userId]).then((r) => r.rows[0].n);
const note = (userId, n, extra = {}) => notificationStore.add({ userId, type: 'price_drop', title: `T${n}`, body: `B${n}`, productUrl: `https://x.com/${n}`, productName: `P${n}`, ...extra });

(async () => {
  await reset();

  console.log('--- 1) saklama sabitleri');
  check('varsayılan saklama 30 gün, kullanıcı başına en fazla 100', [NOTIFICATION_RETENTION_DAYS, NOTIFICATION_MAX_PER_USER], [30, 100]);

  console.log('\n--- 2) kayıt ve listeleme');
  await note('a', 1); await note('a', 2); await note('a', 3); await note('b', 1);
  const list = await notificationStore.listByUser('a');
  check('en yeniden eskiye', list.map((n) => n.title), ['T3', 'T2', 'T1']);
  check('alanlar', { type: list[0].type, productUrl: list[0].productUrl, productName: list[0].productName }, { type: 'price_drop', productUrl: 'https://x.com/3', productName: 'P3' });
  check('limit', (await notificationStore.listByUser('a', 2)).map((n) => n.title), ['T3', 'T2']);
  check('limit üst sınırı aşmaz / geçersiz limit varsayılana düşer', [(await notificationStore.listByUser('a', 99999)).length, (await notificationStore.listByUser('a', 'abc')).length], [3, 3]);
  check('kullanıcılar birbirini görmez', (await notificationStore.listByUser('b')).map((n) => n.title), ['T1']);

  console.log('\n--- 3) kullanıcı başına üst sınır (en yeni 100)');
  for (let i = 1; i <= 105; i++) await note('c', i);
  check('105 eklendi -> 100 kaldı', await count('c'), 100);
  const cList = await notificationStore.listByUser('c', 1000);
  check('en yeniler korundu, en eskiler (T1..T5) silindi', [cList[0].title, cList[99].title], ['T105', 'T6']);

  console.log('\n--- 4) otomatik temizlik: 30 günden eskiler silinir');
  await db.query(`UPDATE notifications SET created_at = now() - interval '31 days' WHERE user_id = 'a' AND title IN ('T1','T2')`);
  await db.query(`UPDATE notifications SET created_at = now() - interval '29 days' WHERE user_id = 'a' AND title = 'T3'`);
  const removed = await notificationStore.pruneOlderThan();
  check('yalnızca 31 günlükler silindi (a: T1,T2)', removed >= 2 && (await notificationStore.listByUser('a')).map((n) => n.title), ['T3']);
  check('29 günlük kayıt duruyor, başkalarının yeni kayıtları etkilenmedi', [await count('a'), await count('b'), await count('c')], [1, 1, 100]);
  check('gün sayısı verilebilir (1 gün)', [await notificationStore.pruneOlderThan(1), await count('a')], [1, 0]);

  console.log('\n--- 5) checker: fiyat düşüşü geçmişe yazılır (cihaz kaydı OLMASA da)');
  const resolved = resolveProductFromHtml({ url: MANGO_URL, html: FIXTURE });
  const variant = resolved.variants.find((v) => v.price != null);
  const target = await trackedTargetStore.create({ urlKey: 'n-chk', brand: 'mango', url: MANGO_URL, name: resolved.name, imageUrl: 'https://img.example/x.jpg', canonicalUrl: resolved.canonicalUrl, variants: resolved.variants.map((v) => ({ ...v })) });
  const sub = await subscriptionStore.create({ userId: 'chk-user', targetId: target.id, sku: variant.sku, notifyOnPriceDrop: true });
  await subscriptionStore.update(sub.id, { lastNotifiedPrice: variant.price + 100, lastNotifiedAvailability: variant.availability });
  const r1 = await checkTrackedTarget(await trackedTargetStore.findById(target.id));
  check('fiyat düşüşü olayı üretildi', r1.events.map((e) => e.type), ['price_drop']);
  const hist = await notificationStore.listByUser('chk-user');
  check('geçmişe 1 kayıt yazıldı', hist.length, 1);
  check('kayıt: tür, başlık, ürün bağlantısı (bildirime dokununca açılacak)', [hist[0].type, hist[0].title.endsWith('fiyatı düştü'), hist[0].productUrl === resolved.canonicalUrl, hist[0].imageUrl], ['price_drop', true, true, 'https://img.example/x.jpg']);
  await checkTrackedTarget(await trackedTargetStore.findById(target.id));
  check('2. kontrol (değişim yok): yinelenen kayıt YOK', await count('chk-user'), 1);

  console.log('\n--- 6) API: yalnızca kendi geçmişi, temizleme, retentionDays');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, token) => {
    const r = await fetch(base + p, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const reg = async () => (await fetch(`${base}/api/auth/register`, { method: 'POST' })).json();
  const A = await reg();
  const B = await reg();
  await note(A.userId, 1); await note(A.userId, 2); await note(B.userId, 9);
  const got = await call('GET', `/api/users/${A.userId}/notifications`, A.token);
  check('200 + yalnızca A\'nın 2 kaydı (yeniden eskiye) + retentionDays', [got.status, got.json.items.map((n) => n.title), got.json.retentionDays], [200, ['T2', 'T1'], 30]);
  check('limit parametresi', (await call('GET', `/api/users/${A.userId}/notifications?limit=1`, A.token)).json.items.length, 1);
  check('token yok -> 401', (await call('GET', `/api/users/${A.userId}/notifications`)).status, 401);
  check('BAŞKASININ geçmişi -> 403', (await call('GET', `/api/users/${B.userId}/notifications`, A.token)).status, 403);
  check('BAŞKASININ geçmişini silemez -> 403, kayıt duruyor', [(await call('DELETE', `/api/users/${B.userId}/notifications`, A.token)).status, await count(B.userId)], [403, 1]);
  check('kendi geçmişini temizler -> 204, yalnızca kendisininki gider', [(await call('DELETE', `/api/users/${A.userId}/notifications`, A.token)).status, await count(A.userId), await count(B.userId)], [204, 0, 1]);
  check('temizleme idempotent', (await call('DELETE', `/api/users/${A.userId}/notifications`, A.token)).status, 204);

  console.log('\n--- 7) hesap silinince geçmiş de silinir');
  await note(B.userId, 10);
  check('B\'nin 2 kaydı var', await count(B.userId), 2);
  check('hesap silme -> 204', (await call('DELETE', `/api/users/${B.userId}`, B.token)).status, 204);
  check('geçmiş silindi', await count(B.userId), 0);
  server.close();

  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
