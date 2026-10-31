// Ürün sayfası kalkınca (404/410 ya da "Sayfa Bulunamadı") takibin sonlandırılması (izole test DB'si + Redis gerekir).
// Tek bir 404 abonelik KAPATMAZ: kesintisiz seri + süre + marka şalteri aranır (bkz. goneDecision.js). Canlı siteye istek atmaz.
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'test-secret-test-secret-test-secret-1234';
const fs = require('fs');
const path = require('path');
const { db, reset } = require('./perf/lib');

const MANGO_URL = 'https://shop.mango.com/tr/tr/p/erkek/ceket/ceket/fitilli-kadife-yakalı-denim-ceket/37084403/30/00';
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/mango-denim-ceket.html'), 'utf8');

// checker yüklenmeden ÖNCE sayfa çekimini değiştir. mode: 'gone' (404) | 'gone410' | 'blocked' | 'ok'
let mode = 'gone';
const fetchHtmlModule = require('./scraper/fetchHtml');
const { looksLikeNotFoundPage, isGoneStatus } = fetchHtmlModule;
fetchHtmlModule.fetchHtml = async () => {
  if (mode === 'gone') return { html: null, source: 'not-found', notFound: true, status: 404 };
  if (mode === 'gone410') return { html: null, source: 'not-found', notFound: true, status: 410 };
  if (mode === 'ok') return { html: FIXTURE, source: 'test' };
  return null; // blocked
};
const { checkTrackedTarget } = require('./checker');
const { decideGone } = require('./goneDecision');
const { PRODUCT_GONE } = require('./constants');
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

const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const resolved = resolveProductFromHtml({ url: MANGO_URL, html: FIXTURE });
const variants = () => resolved.variants.map((v) => ({ ...v }));
let seq = 0;

// Hedef + tek abone. extra: { notFoundSince, notFoundCount } gibi başlangıç durumu.
async function makeTarget({ brand = 'mango', url = MANGO_URL, userId, extra } = {}) {
  seq += 1;
  const target = await trackedTargetStore.create({ urlKey: `gone-${seq}`, brand, url, name: resolved.name, canonicalUrl: resolved.canonicalUrl, variants: variants() });
  if (extra) await trackedTargetStore.update(target.id, extra);
  const sub = userId ? await subscriptionStore.create({ userId, targetId: target.id, sku: resolved.variants[0].sku, notifyOnPriceDrop: true }) : null;
  return { id: target.id, subId: sub?.id };
}
const run = async (id) => checkTrackedTarget(await trackedTargetStore.findById(id));
const isActive = async (subId) => (await subscriptionStore.findById(subId)).active;

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

  console.log('\n--- 2) karar fonksiyonu (saf): ne zaman kapatılır?');
  const now = Date.now();
  let statsCalls = 0;
  const stats = (active, suspects) => async () => { statsCalls += 1; return { active, suspects }; };
  const decide = (input, loader) => decideGone({ status: 404, now, ...input }, loader);
  check('ilk 404 -> wait', await decide({ count: 1, firstSeenAt: now }, stats(10, 1)), 'wait');
  check('çok kontrol ama seri yeni (30 dk) -> wait', await decide({ count: 50, firstSeenAt: now - HOUR / 2 }, stats(10, 1)), 'wait');
  check('1 saat geçti ama yalnızca 2 kontrol -> wait', await decide({ count: 2, firstSeenAt: now - 2 * HOUR }, stats(10, 1)), 'wait');
  check('wait iken marka istatistiği SORGULANMADI (gereksiz DB yükü yok)', statsCalls, 0);
  check('3 kontrol + 1 saat, marka sağlıklı -> remove', await decide({ count: 3, firstSeenAt: now - HOUR }, stats(10, 1)), 'remove');
  check('aynı ama markanın %30\'u 404 serisinde -> hold', await decide({ count: 3, firstSeenAt: now - 2 * HOUR }, stats(10, 3)), 'hold');
  check('küçük marka (4 hedef < 5): oran güvenilmez -> remove', await decide({ count: 3, firstSeenAt: now - 2 * HOUR }, stats(4, 4)), 'remove');
  check('hold bile olsa 24 saat kesintisiz 404 -> remove', await decide({ count: 99, firstSeenAt: now - 25 * HOUR }, stats(10, 10)), 'remove');
  check('410 Gone: bekleme ve şalter yok -> remove', await decide({ status: 410, count: 1, firstSeenAt: now }, stats(10, 10)), 'remove');
  check('eşikler (belgelenmiş varsayılanlar)', [PRODUCT_GONE.minChecks, PRODUCT_GONE.minDurationMs, PRODUCT_GONE.maxHoldMs, PRODUCT_GONE.brandSuspectRatio, PRODUCT_GONE.brandMinTargets], [3, HOUR, 24 * HOUR, 0.3, 5]);

  console.log('\n--- 3) tek/geçici 404 abonelikleri KAPATMAZ');
  const a = await makeTarget({ userId: 'gone-a' });
  const b = await makeTarget({ userId: 'gone-b' });
  const a2 = await subscriptionStore.create({ userId: 'gone-c', targetId: a.id, sku: resolved.variants[1].sku, notifyOnPriceDrop: true });
  mode = 'gone';
  const r1 = await run(a.id);
  const t1 = await trackedTargetStore.findById(a.id);
  check('1. 404: bekleniyor (pending=wait), abonelik yok sayılmadı', [r1.ok, r1.reason, r1.pending], [false, 'NOT_FOUND', 'wait']);
  check('seri başladı: sayaç 1, başlangıç zamanı yazıldı', [t1.notFoundCount, t1.notFoundSince !== null], [1, true]);
  check('abonelikler aktif, hedef aktif', [await isActive(a.subId), await isActive(a2.id), t1.active], [true, true, true]);
  check('hata sayacı ARTMADI (engel değil), son durum NOT_FOUND', [t1.consecutiveFailures, t1.lastCheckStatus], [0, 'NOT_FOUND']);
  check('kullanıcıya bildirim GİTMEDİ', (await notificationStore.listByUser('gone-a')).length, 0);
  await run(a.id); await run(a.id);
  const t3 = await trackedTargetStore.findById(a.id);
  check('3 hızlı 404: sayaç 3 ama süre dolmadı -> hâlâ aktif', [t3.notFoundCount, await isActive(a.subId)], [3, true]);
  check('hedef worker listesinde KALIYOR (taranmaya devam)', (await trackedTargetStore.listActive()).some((x) => x.id === a.id), true);

  console.log('\n--- 4) seri 1 saati aşınca: tüm aboneler kapanır');
  await trackedTargetStore.update(a.id, { notFoundSince: ago(2 * HOUR) });
  const rr = await run(a.id);
  const tr = await trackedTargetStore.findById(a.id);
  check('sonuç: 2 abonelik kapatıldı', [rr.reason, rr.removedSubscriptions], ['NOT_FOUND', 2]);
  check('abonelikler pasif', [await isActive(a.subId), await isActive(a2.id)], [false, false]);
  check('hedef pasif, sayaçlar sıfırlandı (yeniden eklenirse temiz başlar)', [tr.active, tr.notFoundCount, tr.notFoundSince], [false, 0, null]);
  check('"çıkardıktan sonra bekle" cezası YOK (removed_at yazılmadı)', [await subscriptionStore.lastRemovalAt('gone-a'), await subscriptionStore.lastRemovalAt('gone-c')], [null, null]);
  check('ücretsiz slot geri açıldı', await subscriptionStore.countActiveByUser('gone-a'), 0);
  const histA = await notificationStore.listByUser('gone-a');
  check('kullanıcılara "ürün kaldırıldı" kaydı', [histA.map((n) => n.type), (await notificationStore.listByUser('gone-c')).map((n) => n.type)], [['product_removed'], ['product_removed']]);
  check('başlık ürün adını taşıyor', histA[0].title, `${resolved.name} artık satışta değil`);
  check('diğer hedefin aboneliği etkilenmedi', await isActive(b.subId), true);

  console.log('\n--- 5) başarılı kontrol seriyi sıfırlar; engel (FETCH_FAILED) seriyi bozmaz');
  const c = await makeTarget({ userId: 'gone-d', extra: { notFoundSince: ago(HOUR / 2), notFoundCount: 2 } });
  mode = 'blocked';
  await run(c.id);
  const afterBlock = await trackedTargetStore.findById(c.id);
  check('engel: seri korundu (sayaç 2), hata sayacı 1, abonelik aktif', [afterBlock.notFoundCount, afterBlock.consecutiveFailures, await isActive(c.subId)], [2, 1, true]);
  check('engel: bildirim yazılmadı', (await notificationStore.listByUser('gone-d')).length, 0);
  mode = 'ok';
  await run(c.id);
  const afterOk = await trackedTargetStore.findById(c.id);
  check('sayfa geri geldi: seri sıfırlandı', [afterOk.notFoundCount, afterOk.notFoundSince, afterOk.lastCheckStatus], [0, null, 'ok']);
  mode = 'gone';
  await run(c.id);
  check('yeniden 404: sayaç 1\'den başlar (eski seri sayılmaz)', (await trackedTargetStore.findById(c.id)).notFoundCount, 1);

  console.log('\n--- 6) 410 Gone: bekleme yok');
  const d = await makeTarget({ userId: 'gone-e' });
  mode = 'gone410';
  const rd = await run(d.id);
  check('ilk kontrolde kapandı', [rd.removedSubscriptions, await isActive(d.subId)], [1, false]);

  console.log('\n--- 7) marka şalteri: markanın çoğu aynı anda 404 ise abonelikler korunur');
  mode = 'gone';
  const zaraUrl = (i) => `https://www.zara.com/tr/tr/sirket-test-p0000000${i}.html`;
  const zara = [];
  for (let i = 1; i <= 6; i++) zara.push(await makeTarget({ brand: 'zara', url: zaraUrl(i), userId: `zara-u${i}` }));
  // 3/6 (%50) hedef 404 serisinde ve süresi dolmuş.
  for (const t of zara.slice(0, 3)) await trackedTargetStore.update(t.id, { notFoundSince: ago(2 * HOUR), notFoundCount: 2 });
  const held = await run(zara[0].id);
  check('şalter: hold, abonelik korunuyor', [held.pending, await isActive(zara[0].subId)], ['hold', true]);
  check('şalterde bildirim yok', (await notificationStore.listByUser('zara-u1')).length, 0);
  await trackedTargetStore.update(zara[0].id, { notFoundSince: ago(25 * HOUR) });
  const forced = await run(zara[0].id);
  check('24 saat kesintisiz 404: şalter aşılır, kapanır', [forced.removedSubscriptions, await isActive(zara[0].subId)], [1, false]);
  // Aynı markada serisi olmayan sağlıklı hedefler bu sırada etkilenmez.
  check('serisi olmayan komşu hedef etkilenmedi', await isActive(zara[5].subId), true);

  console.log('\n--- 8) API: ürün ekleme sırasında sayfa yoksa 404 PRODUCT_NOT_FOUND (abonelik yok, bekleme gerekmez)');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const userId = 'gone-api-user';
  await userStore.getOrCreate(userId);
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
