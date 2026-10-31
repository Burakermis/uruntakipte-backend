// Ürün sayfası kalkınca (404/410 ya da "Sayfa Bulunamadı") takibin otomatik sonlandırılması
// (izole test DB'si + Redis gerekir). Canlı siteye istek atmaz.
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'test-secret-test-secret-test-secret-1234';
const fs = require('fs');
const path = require('path');
const { db, reset } = require('./perf/lib');

const MANGO_URL = 'https://shop.mango.com/tr/tr/p/erkek/ceket/ceket/fitilli-kadife-yakalı-denim-ceket/37084403/30/00';
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/mango-denim-ceket.html'), 'utf8');

// checker yüklenmeden ÖNCE sayfa çekimini değiştir. mode: 'gone' | 'blocked'
let mode = 'gone';
const fetchHtmlModule = require('./scraper/fetchHtml');
const { looksLikeNotFoundPage, isGoneStatus } = fetchHtmlModule;
fetchHtmlModule.fetchHtml = async () => {
  if (mode === 'gone') return { html: null, source: 'not-found', notFound: true, status: 404 };
  return null;
};
const { checkTrackedTarget } = require('./checker');
const { resolveProductFromHtml } = require('./scraper/registry');
const app = require('./server');
const trackedTargetStore = require('./store/trackedTargetStore');
const subscriptionStore = require('./store/subscriptionStore');
const notificationStore = require('./store/notificationStore');
const userStore = require('./store/userStore');
const { issueToken } = require('./auth/token');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

(async () => {
  await reset();

  console.log('--- 1) "ürün yok" tespiti (yanlış alarm riski bilerek düşük tutuluyor)');
  check('Oysho: <title>Sayfa Bulunamadı | OYSHO</title>', looksLikeNotFoundPage('<html><title>Sayfa Bulunamadı | OYSHO Türkiye</title>'), true);
  check('İngilizce 404 başlıkları', [looksLikeNotFoundPage('<title>404 Not Found</title>'), looksLikeNotFoundPage('<title>Page not found</title>')], [true, true]);
  check('normal ürün başlığı', looksLikeNotFoundPage('<title>Çift kollu tişört | Pull&amp;Bear Turkey</title>'), false);
  check('gövdede "bulunamadı" geçmesi yetmez (yalnızca başlık)', looksLikeNotFoundPage('<title>Ceket</title><body><p>Sayfa bulunamadı hatası için...</p></body>'), false);
  check('başlıkta (başta değil) "bulunamadı" geçerse alarm yok', looksLikeNotFoundPage('<title>Kayıp eşya bulunamadı çantası | Zara</title>'), false);
  check('HTML yok/boş', [looksLikeNotFoundPage(null), looksLikeNotFoundPage('')], [false, false]);
  check('yalnızca 404 ve 410 "ürün yok"; 403/429/500 engel/geçici', [404, 410, 403, 429, 500, null].map(isGoneStatus), [true, true, false, false, false, false]);

  console.log('\n--- 2) kontrol sırasında ürün kalkmış: tüm aboneler takipten çıkar');
  const resolved = resolveProductFromHtml({ url: MANGO_URL, html: FIXTURE });
  const [v1, v2] = resolved.variants;
  const target = await trackedTargetStore.create({ urlKey: 'gone-1', brand: 'mango', url: MANGO_URL, name: resolved.name, canonicalUrl: resolved.canonicalUrl, variants: resolved.variants.map((v) => ({ ...v })) });
  const subA = await subscriptionStore.create({ userId: 'gone-a', targetId: target.id, sku: v1.sku, notifyOnPriceDrop: true });
  const subB = await subscriptionStore.create({ userId: 'gone-b', targetId: target.id, sku: v2.sku, notifyOnPriceDrop: true });
  const other = await trackedTargetStore.create({ urlKey: 'gone-2', brand: 'mango', url: MANGO_URL + '?x=1', name: 'Başka ürün', variants: resolved.variants.map((v) => ({ ...v })) });
  const subOther = await subscriptionStore.create({ userId: 'gone-a', targetId: other.id, sku: v1.sku, notifyOnPriceDrop: true });

  mode = 'gone';
  const r = await checkTrackedTarget(await trackedTargetStore.findById(target.id));
  check('sonuç: NOT_FOUND, 2 abonelik kapatıldı', [r.ok, r.reason, r.removedSubscriptions], [false, 'NOT_FOUND', 2]);
  check('abonelikler pasif', [(await subscriptionStore.findById(subA.id)).active, (await subscriptionStore.findById(subB.id)).active], [false, false]);
  const t = await trackedTargetStore.findById(target.id);
  check('hedef pasif (worker boşuna taramasın), durum NOT_FOUND', [t.active, t.lastCheckStatus], [false, 'NOT_FOUND']);
  check('hata sayacı ARTMADI (engel değil, ürün yok)', [t.consecutiveFailures, t.failureNotifiedAt], [0, null]);
  check('"çıkardıktan sonra bekle" cezası YOK (removed_at yazılmadı)', [await subscriptionStore.lastRemovalAt('gone-a'), await subscriptionStore.lastRemovalAt('gone-b')], [null, null]);
  check('ücretsiz slot geri açıldı (A için yalnızca diğer ürün aktif)', await subscriptionStore.countActiveByUser('gone-a'), 1);
  check('diğer ürünün aboneliği etkilenmedi', (await subscriptionStore.findById(subOther.id)).active, true);

  const histA = await notificationStore.listByUser('gone-a');
  const histB = await notificationStore.listByUser('gone-b');
  check('her iki kullanıcıya geçmişte "ürün kaldırıldı" kaydı', [histA.map((n) => n.type), histB.map((n) => n.type)], [['product_removed'], ['product_removed']]);
  check('başlık ürün adını taşıyor', histA[0].title, `${resolved.name} artık satışta değil`);
  check('pasif hedef worker listesinde YOK', (await trackedTargetStore.listActive()).some((x) => x.id === target.id), false);

  console.log('\n--- 3) engel/geçici hata: abonelik KORUNUR (yanlışlıkla silme yok)');
  const target2 = await trackedTargetStore.create({ urlKey: 'blk-1', brand: 'mango', url: MANGO_URL + '?y=2', name: 'Engelli ürün', variants: resolved.variants.map((v) => ({ ...v })) });
  const subC = await subscriptionStore.create({ userId: 'blk-user', targetId: target2.id, sku: v1.sku, notifyOnPriceDrop: true });
  mode = 'blocked';
  const rb = await checkTrackedTarget(await trackedTargetStore.findById(target2.id));
  const t2 = await trackedTargetStore.findById(target2.id);
  check('FETCH_FAILED, hata sayacı 1', [rb.reason, t2.consecutiveFailures], ['FETCH_FAILED', 1]);
  check('abonelik ve hedef hâlâ aktif', [(await subscriptionStore.findById(subC.id)).active, t2.active], [true, true]);
  check('bildirim yazılmadı', (await notificationStore.listByUser('blk-user')).length, 0);

  console.log('\n--- 4) API: ürün ekleme sırasında sayfa yoksa 404 PRODUCT_NOT_FOUND');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const userId = 'gone-api-user';
  await userStore.getOrCreate(userId);
  mode = 'gone';
  const res = await fetch(`${base}/api/products/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issueToken(userId)}` },
    body: JSON.stringify({ url: MANGO_URL + '?z=3' }),
  });
  const body = await res.json();
  check('resolve: 404 + PRODUCT_NOT_FOUND (502 FETCH_FAILED değil)', [res.status, body.error], [404, 'PRODUCT_NOT_FOUND']);
  server.close();

  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
