// Premium senkronu ve abonelik sertleştirmeleri (izole test DB'si + Redis gerekir). RevenueCat ve mağaza siteleri
// GERÇEKTEN çağrılmaz: global fetch RevenueCat için taklit edilir, ürünler önceden DB'ye konur, tarama kuyruğu sayılır.
//   1) olay sırası  2) EXPIRATION/CANCELLATION/TRANSFER'in gerçek duruma bakması  3) premium bitince limit uygulama
//   4) günlük uzlaştırma  5) sync-premium hız sınırı  6) limitin taramadan ÖNCE kontrolü + kullanıcı başına tarama sınırı
//   7) yetim hedef temizliği  8) cihaz jetonu sınırı  9) üretim yapılandırma kontrolü
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.REVENUECAT_SECRET_KEY = 'rc-test-key';
delete process.env.REVENUECAT_WEBHOOK_SECRET;
const fs = require('fs');
const path = require('path');
const express = require('express');
const { db, reset } = require('./perf/lib');

// ---- RevenueCat taklidi: kullanıcı -> 'active' | 'none' | 'error' | '404'
const realFetch = global.fetch;
const rc = new Map();
const rcCalls = [];
global.fetch = async (url, opts) => {
  const m = String(url).match(/api\.revenuecat\.com\/v1\/subscribers\/(.+)$/);
  if (!m) return realFetch(url, opts);
  const id = decodeURIComponent(m[1]);
  rcCalls.push(id);
  const state = rc.get(id) || 'none';
  if (state === 'error') return new Response('boom', { status: 500 });
  if (state === '404') return new Response('{}', { status: 404 });
  const entitlements = state === 'active' ? { pro: { product_identifier: 'p1', expires_date: new Date(Date.now() + 86400000).toISOString() } } : {};
  return new Response(JSON.stringify({ subscriber: { entitlements, subscriptions: { p1: { is_sandbox: false } } } }), { status: 200 });
};

// ---- tarama kuyruğu taklidi: kaç kez tarama işi eklendiğini sayar, işi başarısız bitirir (502)
const queueMod = require('./queue/scrapeQueue');
let scrapeCalls = 0;
queueMod.scrapeQueue.add = async () => {
  scrapeCalls += 1;
  return { waitUntilFinished: async () => { throw new Error('test: tarama yok'); } };
};

const { normalizeTrackingUrl } = require('./scraper/normalizeUrl');
const { resolveProductFromHtml } = require('./scraper/registry');
const trackedTargetStore = require('./store/trackedTargetStore');
const subscriptionStore = require('./store/subscriptionStore');
const deviceTokenStore = require('./store/deviceTokenStore');
const notificationStore = require('./store/notificationStore');
const userStore = require('./store/userStore');
const { setPlan } = require('./billing/plan');
const { reconcilePremium } = require('./billing/reconcile');
const { assertBillingConfig } = require('./config');
const { MAX_DEVICE_TOKENS_PER_USER } = require('./constants');
const app = require('./server');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/mango-denim-ceket.html'), 'utf8');
const urlFor = (i) => `https://shop.mango.com/tr/tr/p/erkek/ceket/ceket/bill-${i}/3708440${i}/30/00`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await reset();
  const variants = resolveProductFromHtml({ url: urlFor(0), html: FIXTURE }).variants.map((v) => ({ ...v }));
  const sku = variants[0].sku;
  const targets = [];
  for (let i = 1; i <= 8; i++) {
    targets.push(await trackedTargetStore.create({ urlKey: normalizeTrackingUrl(urlFor(i)), brand: 'mango', url: urlFor(i), name: `Bill ${i}`, canonicalUrl: urlFor(i), variants }));
  }
  const premium = async (id) => (await db.query('SELECT is_premium FROM users WHERE user_id = $1', [id])).rows[0]?.is_premium ?? null;
  const activeTargets = async (id) => (await db.query('SELECT target_id FROM subscriptions WHERE user_id = $1 AND active ORDER BY target_id', [id])).rows.map((r) => r.target_id);
  const track = async (userId, n) => { for (let i = 0; i < n; i++) await subscriptionStore.create({ userId, targetId: targets[i].id, sku, notifyOnPriceDrop: true }); };

  // ---- webhook uygulaması (kimlik katmanı yok: webhook kendi secret'ını kullanır; test modunda secret'sız kabul)
  const wapp = express();
  wapp.use(express.json());
  wapp.use('/webhooks', require('./routes/webhooks'));
  const wsrv = await new Promise((resolve) => { const s = wapp.listen(0, () => resolve(s)); });
  const hook = async (event) => {
    const res = await realFetch(`http://127.0.0.1:${wsrv.address().port}/webhooks/revenuecat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event }) });
    return { status: res.status, json: await res.json() };
  };

  console.log('--- 1) olay sırası: eski olay daha yeni durumu ezmez');
  const U = 'bill-order';
  check('satın alma (t=2000) -> premium', [(await hook({ type: 'INITIAL_PURCHASE', app_user_id: U, event_timestamp_ms: 2000 })).status, await premium(U)], [200, true]);
  rc.set(U, 'none');
  await hook({ type: 'EXPIRATION', app_user_id: U, event_timestamp_ms: 1000 });
  check('ESKİ bir EXPIRATION (t=1000) geç geldi -> premium KALIR', await premium(U), true);
  await hook({ type: 'EXPIRATION', app_user_id: U, event_timestamp_ms: 3000 });
  check('güncel EXPIRATION (t=3000) -> ücretsiz', await premium(U), false);
  await hook({ type: 'EXPIRATION', app_user_id: U, event_timestamp_ms: 3000 });
  check('aynı olay yeniden iletildi -> idempotent, ücretsiz', await premium(U), false);
  await hook({ type: 'RENEWAL', app_user_id: U, event_timestamp_ms: 2500 });
  check('ESKİ bir RENEWAL (t=2500) geç geldi -> ücretsiz KALIR (süre dolmuş hesabı geri açmaz)', await premium(U), false);
  await hook({ type: 'RENEWAL', app_user_id: U, event_timestamp_ms: 4000 });
  check('yeni RENEWAL (t=4000) -> premium', await premium(U), true);
  await hook({ type: 'RENEWAL', app_user_id: 'bill-notime' });
  check('zaman damgasız olay da uygulanır (geriye uyum)', await premium('bill-notime'), true);

  console.log('\n--- 2) EXPIRATION / CANCELLATION / TRANSFER gerçek duruma bakar');
  const E1 = 'bill-exp-other';
  await hook({ type: 'INITIAL_PURCHASE', app_user_id: E1, event_timestamp_ms: 1000 });
  rc.set(E1, 'active');
  await hook({ type: 'EXPIRATION', app_user_id: E1, event_timestamp_ms: 2000 });
  check('EXPIRATION ama başka aktif yetkisi var -> premium kalır', await premium(E1), true);

  const E2 = 'bill-exp-down';
  await hook({ type: 'INITIAL_PURCHASE', app_user_id: E2, event_timestamp_ms: 1000 });
  rc.set(E2, 'error');
  await hook({ type: 'EXPIRATION', app_user_id: E2, event_timestamp_ms: 2000 });
  check('EXPIRATION + RevenueCat erişilemiyor -> süre dolmuş say (güvenli varsayım)', await premium(E2), false);

  const C1 = 'bill-cancel-keep';
  await hook({ type: 'INITIAL_PURCHASE', app_user_id: C1, event_timestamp_ms: 1000 });
  rc.set(C1, 'active');
  await hook({ type: 'CANCELLATION', app_user_id: C1, event_timestamp_ms: 2000 });
  check('CANCELLATION (yenilenmeyecek ama dönem sürüyor) -> premium kalır', await premium(C1), true);

  const C2 = 'bill-cancel-refund';
  await hook({ type: 'INITIAL_PURCHASE', app_user_id: C2, event_timestamp_ms: 1000 });
  rc.set(C2, 'none');
  await hook({ type: 'CANCELLATION', app_user_id: C2, event_timestamp_ms: 2000, cancel_reason: 'CUSTOMER_SUPPORT' });
  check('CANCELLATION + yetki yok (iade) -> premium biter', await premium(C2), false);

  const C3 = 'bill-cancel-down';
  await hook({ type: 'INITIAL_PURCHASE', app_user_id: C3, event_timestamp_ms: 1000 });
  rc.set(C3, 'error');
  await hook({ type: 'CANCELLATION', app_user_id: C3, event_timestamp_ms: 2000 });
  check('CANCELLATION + RevenueCat erişilemiyor -> dokunulmaz (yanlışlıkla düşürmez)', await premium(C3), true);

  const TA = 'bill-transfer-from';
  const TB = 'bill-transfer-to';
  await hook({ type: 'INITIAL_PURCHASE', app_user_id: TA, event_timestamp_ms: 1000 });
  rc.set(TA, 'none'); rc.set(TB, 'active');
  await hook({ type: 'TRANSFER', transferred_from: [TA, '$RCAnonymousID:abc'], transferred_to: [TB], event_timestamp_ms: 2000 });
  check('TRANSFER: eski kimlik ücretsiz, yeni kimlik premium', [await premium(TA), await premium(TB)], [false, true]);
  check('TRANSFER: misafir (anonim) kimlik için satır açılmadı', await premium('$RCAnonymousID:abc'), null);

  const TC = 'bill-transfer-fb-from';
  const TD = 'bill-transfer-fb-to';
  await hook({ type: 'INITIAL_PURCHASE', app_user_id: TC, event_timestamp_ms: 1000 });
  rc.set(TC, 'error'); rc.set(TD, 'error');
  await hook({ type: 'TRANSFER', transferred_from: [TC], transferred_to: [TD], event_timestamp_ms: 2000 });
  check('TRANSFER + RevenueCat erişilemiyor -> varsayım: eski ücretsiz, yeni premium', [await premium(TC), await premium(TD)], [false, true]);

  check('anonim app_user_id olayı yok sayılır, satır açılmaz', [(await hook({ type: 'INITIAL_PURCHASE', app_user_id: '$RCAnonymousID:zzz' })).json.ignored, await premium('$RCAnonymousID:zzz')], ['ANONYMOUS', null]);
  check('app_user_id yok -> 400', (await hook({ type: 'RENEWAL' })).status, 400);
  check('BILLING_ISSUE gibi olaylar premium\'u değiştirmez', [(await hook({ type: 'BILLING_ISSUE', app_user_id: U, event_timestamp_ms: 9000 })).status, await premium(U)], [200, true]);

  console.log('\n--- 3) premium bitince ücretsiz limit UYGULANIR (en eski 3 ürün kalır, bekleme cezası yok)');
  const D = 'bill-downgrade';
  await userStore.setPremium(D, true);
  await track(D, 6);
  const fewUser = 'bill-few';
  await userStore.setPremium(fewUser, true);
  await track(fewUser, 2);
  const exactUser = 'bill-exact';
  await userStore.setPremium(exactUser, true);
  await track(exactUser, 3);
  for (const id of [D, fewUser, exactUser]) rc.set(id, 'none');
  for (const id of [D, fewUser, exactUser]) await hook({ type: 'EXPIRATION', app_user_id: id, event_timestamp_ms: 5000 });
  check('6 üründen en eski 3\'ü aktif kaldı', await activeTargets(D), targets.slice(0, 3).map((t) => t.id));
  check('fazlası pasif ama removed_at YOK (48 saatlik bekleme tetiklenmez)', [(await db.query('SELECT count(*)::int n FROM subscriptions WHERE user_id=$1 AND NOT active', [D])).rows[0].n, await subscriptionStore.lastRemovalAt(D)], [3, null]);
  const notes = await notificationStore.listByUser(D);
  check('kullanıcıya "plan sona erdi" bildirimi yazıldı', [notes.map((n) => n.type), notes[0].body.includes('3 ürün')], [['plan_downgraded'], true]);
  check('limitin altındaki / tam sınırdaki kullanıcılara dokunulmadı', [(await activeTargets(fewUser)).length, (await activeTargets(exactUser)).length, (await notificationStore.listByUser(fewUser)).length], [2, 3, 0]);
  await hook({ type: 'EXPIRATION', app_user_id: D, event_timestamp_ms: 5000 });
  check('olay yeniden iletildi: ikinci bildirim/değişiklik YOK (idempotent)', [(await notificationStore.listByUser(D)).length, (await activeTargets(D)).length], [1, 3]);
  check('premium kullanıcı (süresi dolmamış) etkilenmez', await (async () => { const P = 'bill-still'; await userStore.setPremium(P, true); await track(P, 6); await setPlan(P, true); return (await activeTargets(P)).length; })(), 6);

  console.log('\n--- 4) günlük uzlaştırma: kaçan EXPIRATION/iade olayı premium\'u sonsuza kadar açık bırakmaz');
  // Önceki bölümlerde premium yapılan kullanıcılar bu bölümün sayımına karışmasın.
  await db.query("UPDATE users SET is_premium = false WHERE user_id LIKE 'bill-%' AND user_id NOT LIKE 'bill-rec-%'");
  const R1 = 'bill-rec-active'; const R2 = 'bill-rec-expired'; const R3 = 'bill-rec-error'; const R4 = 'bill-rec-free';
  for (const id of [R1, R2, R3]) await userStore.setPremium(id, true);
  await userStore.setPremium(R4, false);
  await track(R2, 5);
  rc.set(R1, 'active'); rc.set(R2, 'none'); rc.set(R3, 'error'); rc.set(R4, 'active');
  rcCalls.length = 0;
  const sum = await reconcilePremium({ limit: 50, staleMs: 0 });
  check('özet: 3 kullanıcı sorgulandı, 2 doğrulandı, 1 düşürüldü, 1 hata', [sum.due, sum.checked, sum.downgraded, sum.failed], [3, 2, 1, 1]);
  check('aktif -> premium kalır; süresi dolmuş -> ücretsiz', [await premium(R1), await premium(R2)], [true, false]);
  check('düşürülen kullanıcının ürün sınırı uygulandı (5 -> 3)', (await activeTargets(R2)).length, 3);
  check('RevenueCat erişilemedi -> premium KORUNDU (kesinti kullanıcıyı düşürmez)', await premium(R3), true);
  check('ücretsiz kullanıcı sorgulanmaz (RevenueCat kotası boşa gitmez)', rcCalls.includes(R4), false);
  const sum2 = await reconcilePremium({ limit: 50, staleMs: 24 * 3600 * 1000 });
  check('hemen tekrar: doğrulananlar atlanır, yalnızca hatalı olan yeniden denenir', [sum2.due, sum2.checked, sum2.failed], [1, 0, 1]);
  const savedKey = process.env.REVENUECAT_SECRET_KEY;
  delete process.env.REVENUECAT_SECRET_KEY;
  check('sunucu anahtarı yoksa uzlaştırma atlanır', (await reconcilePremium({ staleMs: 0 })).skipped, 'NOT_CONFIGURED');
  process.env.REVENUECAT_SECRET_KEY = savedKey;

  console.log('\n--- 5) sync-premium: kullanıcı başına hız sınırı + sonuç');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const register = async () => (await realFetch(`${base}/api/auth/register`, { method: 'POST' })).json();
  const hdr = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  const sync = (u) => realFetch(`${base}/api/users/${u.userId}/sync-premium`, { method: 'POST', headers: hdr(u.token), body: '{}' });
  const s1 = await register();
  rc.set(s1.userId, 'active');
  const first = await sync(s1);
  check('sync: RevenueCat aktif -> premium', [first.status, (await first.json()).isPremium, await premium(s1.userId)], [200, true, true]);
  rc.set(s1.userId, 'none');
  const second = await sync(s1);
  check('sync: yetki bitti -> ücretsiz (iki yönlü)', [second.status, (await second.json()).isPremium], [200, false]);
  const rest = [];
  for (let i = 0; i < 5; i++) rest.push((await sync(s1)).status);
  check('6 çağrıdan sonra 7. çağrı hız sınırına takıldı', rest, [200, 200, 200, 200, 429]);
  const s2 = await register();
  check('başka kullanıcı etkilenmedi', (await sync(s2)).status, 200);
  const s3 = await register();
  rc.set(s3.userId, 'error');
  check('RevenueCat hatası -> 502', (await sync(s3)).status, 502);

  console.log('\n--- 6) limit taramadan ÖNCE kontrol edilir; kullanıcı başına tarama sınırı');
  const add = (u, url, s = sku) => realFetch(`${base}/api/products`, { method: 'POST', headers: hdr(u.token), body: JSON.stringify({ userId: u.userId, url, sku: s }) });
  const full = await register();
  for (const i of [1, 2, 3]) await add(full, urlFor(i));
  scrapeCalls = 0;
  const denied = await add(full, urlFor(7) + '?bilinmeyen=1');
  check('limit dolu + görülmemiş URL -> 403 ve TARAMA BAŞLAMADI', [denied.status, (await denied.json()).error, scrapeCalls], [403, 'PREMIUM_LIMIT_REACHED', 0]);
  const knownSize = await add(full, urlFor(1), variants[1].sku);
  check('limit dolu ama bilinen ürünün başka bedeni -> 201, tarama yok', [knownSize.status, scrapeCalls], [201, 0]);

  const cool = await register();
  const created = [];
  for (const i of [1, 2]) created.push(await (await add(cool, urlFor(i))).json());
  await realFetch(`${base}/api/products/${created[0].id}?userId=${cool.userId}`, { method: 'DELETE', headers: hdr(cool.token) });
  scrapeCalls = 0;
  const cooled = await add(cool, urlFor(7) + '?bilinmeyen=2');
  check('bekleme sürüyor + görülmemiş URL -> 429 ve TARAMA BAŞLAMADI', [cooled.status, (await cooled.json()).error, scrapeCalls], [429, 'PREMIUM_COOLDOWN_ACTIVE', 0]);

  const roomy = await register();
  scrapeCalls = 0;
  const allowed = await add(roomy, urlFor(7) + '?bilinmeyen=3');
  check('yeri olan kullanıcı + görülmemiş URL -> tarama BAŞLATILIR (taklit kuyruk hata verir: 502)', [allowed.status, scrapeCalls], [502, 1]);

  const rich = await register();
  await userStore.setPremium(rich.userId, true);
  scrapeCalls = 0;
  for (const i of [1, 2, 3, 4]) await add(rich, urlFor(i));
  const richNew = await add(rich, urlFor(7) + '?bilinmeyen=4');
  check('premium: limit yok, tarama başlatılır', [richNew.status, scrapeCalls], [502, 1]);

  const spam = await register();
  const other = await register();
  const resolveCall = (u) => realFetch(`${base}/api/products/resolve`, { method: 'POST', headers: hdr(u.token), body: JSON.stringify({ url: 'https://example.com/x' }) });
  const codes = [];
  for (let i = 0; i < 31; i++) codes.push((await resolveCall(spam)).status);
  check('30 resolve sonrası 31. -> 429 (kullanıcı başına sınır)', [codes.slice(0, 30).every((c) => c === 422), codes[30]], [true, 429]);
  check('başka kullanıcı etkilenmedi', (await resolveCall(other)).status, 422);
  server.close();
  wsrv.close();

  console.log('\n--- 7) yetim hedef temizliği');
  const old = await trackedTargetStore.create({ urlKey: 'orphan-old', brand: 'zara', url: 'https://www.zara.com/tr/tr/o-p00000001.html', name: 'Yetim eski', variants });
  const fresh = await trackedTargetStore.create({ urlKey: 'orphan-fresh', brand: 'zara', url: 'https://www.zara.com/tr/tr/o-p00000002.html', name: 'Yetim yeni', variants });
  const owned = await trackedTargetStore.create({ urlKey: 'owned', brand: 'zara', url: 'https://www.zara.com/tr/tr/o-p00000003.html', name: 'Sahipli', variants });
  await subscriptionStore.create({ userId: 'orphan-owner', targetId: owned.id, sku, notifyOnPriceDrop: true });
  await db.query("UPDATE tracked_targets SET created_at = now() - interval '3 hours' WHERE id = ANY($1::int[])", [[old.id, owned.id]]);
  const statsBefore = await trackedTargetStore.notFoundStatsByBrand('zara');
  check('marka istatistiği yalnızca abonesi olan hedefleri sayar (yetimler seyreltmez)', statsBefore.active, 1);
  const deactivated = await trackedTargetStore.deactivateOrphans(60 * 60 * 1000);
  const activeOf = async (t) => (await trackedTargetStore.findById(t.id)).active;
  check('eski yetim pasifleşti; yeni (ilk aboneliği gelebilir) ve sahipli hedef dokunulmadı', [deactivated >= 1, await activeOf(old), await activeOf(fresh), await activeOf(owned)], [true, false, true, true]);

  console.log('\n--- 8) cihaz jetonu sınırı');
  const tokenUser = 'bill-tokens';
  for (let i = 1; i <= MAX_DEVICE_TOKENS_PER_USER + 5; i++) {
    await deviceTokenStore.upsert({ userId: tokenUser, expoPushToken: `ExponentPushToken[t${i}]`, platform: 'ios' });
    await sleep(5);
  }
  const kept = (await deviceTokenStore.listByUser(tokenUser)).map((t) => t.expoPushToken);
  check(`en fazla ${MAX_DEVICE_TOKENS_PER_USER} jeton kalır`, kept.length, MAX_DEVICE_TOKENS_PER_USER);
  check('en yeniler korunur, en eskiler silinir', [kept.includes('ExponentPushToken[t15]'), kept.includes('ExponentPushToken[t1]')], [true, false]);
  await deviceTokenStore.upsert({ userId: 'bill-tokens-other', expoPushToken: 'ExponentPushToken[x]', platform: 'ios' });
  check('başka kullanıcının jetonları etkilenmez', (await deviceTokenStore.listByUser('bill-tokens-other')).length, 1);

  console.log('\n--- 9) üretim yapılandırma kontrolü');
  const cfg = (env) => { try { assertBillingConfig(env); return 'ok'; } catch { return 'hata'; } };
  const full2 = { NODE_ENV: 'production', REVENUECAT_WEBHOOK_SECRET: 'a', REVENUECAT_SECRET_KEY: 'b' };
  check('production + ikisi de var -> açılır', cfg(full2), 'ok');
  check('production + webhook secret yok -> açılmaz', cfg({ ...full2, REVENUECAT_WEBHOOK_SECRET: '' }), 'hata');
  check('production + sunucu anahtarı yok -> açılmaz', cfg({ ...full2, REVENUECAT_SECRET_KEY: '  ' }), 'hata');
  check('production + ALLOW_MISSING_BILLING=1 (ücretsiz sürüm) -> açılır', cfg({ NODE_ENV: 'production', ALLOW_MISSING_BILLING: '1' }), 'ok');
  check('development\'ta zorunlu değil', cfg({ NODE_ENV: 'development' }), 'ok');

  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
