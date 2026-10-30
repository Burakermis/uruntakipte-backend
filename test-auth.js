// Kimlik doğrulama gerileme testi: GERÇEK server.js uygulamasına karşı (izole test DB'si + Redis gerekir).
// Eski saldırı: userId tek erişim anahtarıydı; bilen başkasının listesini okur/siler, bildirimlerini
// kendi cihazına yönlendirirdi. Artık hepsi token ister ve token başka userId'ye çevrilemez.
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'test-secret-test-secret-test-secret-1234';
const { db, reset } = require('./perf/lib');
const app = require('./server');
const { issueToken, verifyToken, assertConfigured } = require('./auth/token');
const subscriptionStore = require('./store/subscriptionStore');
const trackedTargetStore = require('./store/trackedTargetStore');
const deviceTokenStore = require('./store/deviceTokenStore');
const userStore = require('./store/userStore');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

(async () => {
  await reset();
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { token, body } = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  console.log('--- 1) kayıt: sunucu kimlik üretir');
  const a = await call('POST', '/api/auth/register');
  const b = await call('POST', '/api/auth/register');
  check('201', [a.status, b.status], [201, 201]);
  check('userId ve token döner', [typeof a.json.userId, typeof a.json.token], ['string', 'string']);
  check('iki kayıt farklı kimlik', a.json.userId !== b.json.userId, true);
  check('token kendi userId\'sine çözülür', verifyToken(a.json.token), a.json.userId);
  check('kullanıcı satırı oluştu', (await userStore.isPremium(a.json.userId)), false);
  check('istemci kimlik dayatamaz (gövdedeki userId yok sayılır)', (await call('POST', '/api/auth/register', { body: { userId: 'kurban' } })).json.userId !== 'kurban', true);

  console.log('\n--- 2) token olmadan/bozukken hiçbir uç açık değil');
  const A = a.json.userId, tokA = a.json.token;
  const B = b.json.userId, tokB = b.json.token;
  const protectedCalls = [
    ['GET', `/api/products?userId=${A}`],
    ['POST', '/api/products/resolve', { url: 'https://www.zara.com/tr/tr/x-p1.html' }],
    ['POST', '/api/products', { userId: A, url: 'https://www.zara.com/x', sku: '1' }],
    ['DELETE', `/api/products/1?userId=${A}`],
    ['POST', '/api/products/1/check-now', { userId: A }],
    ['GET', `/api/users/${A}/limits`],
    ['POST', `/api/users/${A}/premium`, { isPremium: true }],
    ['POST', `/api/users/${A}/sync-premium`, {}],
    ['POST', '/api/devices', { userId: A, expoPushToken: 'ExponentPushToken[x]', platform: 'ios' }],
    ['DELETE', `/api/devices?userId=${A}`],
  ];
  for (const [m, p, body] of protectedCalls) {
    check(`token yok  ${m} ${p.slice(0, 40)}`, (await call(m, p, { body })).status, 401);
  }
  const forged = `${A}.${'x'.repeat(43)}`;
  const swapped = `${B}.${tokA.split('.').pop()}`; // A'nın imzası B'nin kimliğine yapıştırıldı
  for (const [label, t] of [['sahte imza', forged], ['imza başka kimliğe taşındı', swapped], ['sadece userId', A], ['boş imza', `${A}.`], ['çöp', 'abc']]) {
    check(`${label} -> 401`, (await call('GET', `/api/users/${A}/limits`, { token: t })).status, 401);
  }
  const wrongSecret = (() => { const saved = process.env.AUTH_SECRET; process.env.AUTH_SECRET = 'baska-bir-anahtar-baska-bir-anahtar-123'; const t = issueToken(A); process.env.AUTH_SECRET = saved; return t; })();
  check('başka anahtarla imzalı token -> 401', (await call('GET', `/api/users/${A}/limits`, { token: wrongSecret })).status, 401);

  console.log('\n--- 3) geçerli token yalnızca kendi kimliğine erişir');
  check('kendi limitleri -> 200', (await call('GET', `/api/users/${A}/limits`, { token: tokA })).status, 200);
  check('BAŞKASININ limitleri -> 403', (await call('GET', `/api/users/${B}/limits`, { token: tokA })).status, 403);
  check('kendi listesi -> 200', (await call('GET', `/api/products?userId=${A}`, { token: tokA })).status, 200);
  check('BAŞKASININ listesi -> 403', (await call('GET', `/api/products?userId=${B}`, { token: tokA })).status, 403);
  check('BAŞKASI adına ürün ekleme -> 403', (await call('POST', '/api/products', { token: tokA, body: { userId: B, url: 'https://www.zara.com/x', sku: '1' } })).status, 403);
  check('BAŞKASININ premium sync\'i -> 403', (await call('POST', `/api/users/${B}/premium`, { token: tokA, body: { isPremium: true } })).status, 403);
  check('  ... B premium OLMADI', await userStore.isPremium(B), false);
  check('kendi dev-premium (test modu) -> 200', (await call('POST', `/api/users/${A}/premium`, { token: tokA, body: { isPremium: true } })).status, 200);

  console.log('\n--- 4) başkasının aboneliğini silme / bildirimini ele geçirme');
  const target = await trackedTargetStore.create({
    urlKey: 'auth-x', brand: 'mango', url: 'https://shop.mango.com/auth-x', name: 'X',
    variants: [{ sku: 's', color: 'c', size: 'M', price: 100, currency: 'TRY', availability: 'in_stock' }],
  });
  {
    const sub = await subscriptionStore.create({ userId: B, targetId: target.id, sku: 's', notifyOnPriceDrop: true });
    check('A, B\'nin aboneliğini silemez (userId=A ile)', (await call('DELETE', `/api/products/${sub.id}?userId=${A}`, { token: tokA })).status, 404);
    check('A, B\'nin kimliğiyle silemez', (await call('DELETE', `/api/products/${sub.id}?userId=${B}`, { token: tokA })).status, 403);
    check('  ... abonelik hâlâ aktif', (await subscriptionStore.findById(sub.id)).active, true);
    check('B kendi aboneliğini siler', (await call('DELETE', `/api/products/${sub.id}?userId=${B}`, { token: tokB })).status, 204);
  }
  const TOKEN = 'ExponentPushToken[kurban-cihazi]';
  await deviceTokenStore.upsert({ userId: B, expoPushToken: TOKEN, platform: 'ios' });
  check('A, B adına cihaz kaydedemez', (await call('POST', '/api/devices', { token: tokA, body: { userId: B, expoPushToken: 'ExponentPushToken[saldirgan]', platform: 'ios' } })).status, 403);
  check('A, B\'nin bildirimlerini kapatamaz', (await call('DELETE', `/api/devices?userId=${B}`, { token: tokA })).status, 403);
  check('  ... B\'nin token\'ı yerinde', (await deviceTokenStore.listByUser(B)).map((t) => t.expoPushToken), [TOKEN]);
  check('A kendi cihazını kaydeder', (await call('POST', '/api/devices', { token: tokA, body: { userId: A, expoPushToken: 'ExponentPushToken[a]', platform: 'ios' } })).status, 201);

  console.log('\n--- 5) açık kalması gerekenler');
  check('health açık', (await call('GET', '/api/health')).status, 200);
  check('webhook kendi secret\'ıyla (token istemez): secret yoksa dev/test modunda kabul', (await call('POST', '/webhooks/revenuecat', { body: { event: { type: 'TEST', app_user_id: 'x' } } })).status, 200);

  console.log('\n--- 6) AUTH_SECRET yapılandırma kontrolü (fail-closed)');
  const savedEnv = { node: process.env.NODE_ENV, secret: process.env.AUTH_SECRET };
  const tries = (env, secret) => { process.env.NODE_ENV = env; if (secret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = secret; try { assertConfigured(); return 'ok'; } catch { return 'hata'; } };
  check('production + anahtar yok -> açılmaz', tries('production', undefined), 'hata');
  check('production + kısa anahtar -> açılmaz', tries('production', 'kisa'), 'hata');
  check('production + 32+ anahtar -> açılır', tries('production', 'x'.repeat(32)), 'ok');
  check('NODE_ENV tanımsız + anahtar yok -> açılmaz', tries(undefined, undefined) , 'hata');
  check('development + anahtar yok -> dev anahtarı', tries('development', undefined), 'ok');
  process.env.NODE_ENV = 'production'; delete process.env.AUTH_SECRET;
  check('anahtarsız production: hiçbir token geçerli değil', verifyToken(`${A}.${'A'.repeat(43)}`), null);
  process.env.NODE_ENV = savedEnv.node; process.env.AUTH_SECRET = savedEnv.secret;

  console.log('\n--- 7) canlıda varsayılan veritabanı parolası reddedilir');
  const { assertProductionConfig } = require('./config');
  const dbTry = (env, url) => {
    process.env.NODE_ENV = env;
    process.env.DATABASE_URL = url;
    try { assertProductionConfig(); return 'ok'; } catch { return 'hata'; }
  };
  const savedDb = process.env.DATABASE_URL;
  check('production + trackprice parolası -> açılmaz', dbTry('production', 'postgres://trackprice:trackprice@db:5432/trackprice'), 'hata');
  check('production + güçlü parola -> açılır', dbTry('production', 'postgres://trackprice:Gz8-k2LmQx@db:5432/trackprice'), 'ok');
  check('production + DATABASE_URL yok -> parola şikâyeti yok', dbTry('production', ''), 'ok');
  check('development + trackprice -> açılır (yerel akış)', dbTry('development', 'postgres://trackprice:trackprice@localhost:5433/trackprice'), 'ok');
  process.env.DATABASE_URL = savedDb;
  process.env.NODE_ENV = savedEnv.node;

  console.log('\n--- 8) hesap silme: veri gider, anahtar ölür, hesap geri doğmaz');
  const dRes = await call('POST', '/api/auth/register');
  const D = dRes.json.userId, tokD = dRes.json.token;
  const eRes = await call('POST', '/api/auth/register');
  const E = eRes.json.userId, tokE = eRes.json.token;
  const dTarget = await trackedTargetStore.create({
    urlKey: 'del-x', brand: 'mango', url: 'https://shop.mango.com/del-x', name: 'D', variants: [{ sku: 's', color: 'c', size: 'M', price: 100, currency: 'TRY', availability: 'in_stock' }],
  });
  const dSub = await subscriptionStore.create({ userId: D, targetId: dTarget.id, sku: 's', notifyOnPriceDrop: true });
  const dGone = await subscriptionStore.create({ userId: D, targetId: dTarget.id, sku: 's2', notifyOnPriceDrop: true });
  await subscriptionStore.remove(dGone.id); // kaldırılmış (soft-delete) kayıt da silinmeli
  const eSub = await subscriptionStore.create({ userId: E, targetId: dTarget.id, sku: 's', notifyOnPriceDrop: true });
  await deviceTokenStore.upsert({ userId: D, expoPushToken: 'ExponentPushToken[d-cihaz]', platform: 'android' });
  await deviceTokenStore.upsert({ userId: E, expoPushToken: 'ExponentPushToken[e-cihaz]', platform: 'ios' });
  await userStore.setPremium(D, true);
  const count = (table, id) => db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [id]).then((r) => r.rows[0].n);

  check('başkasının hesabını silemez (token A, yol D) -> 403', (await call('DELETE', `/api/users/${D}`, { token: tokE })).status, 403);
  check('  ... D\'nin verisi yerinde', [await count('subscriptions', D), await count('device_tokens', D), await count('users', D)], [2, 1, 1]);
  check('token olmadan -> 401', (await call('DELETE', `/api/users/${D}`)).status, 401);

  check('kendi hesabını siler -> 204', (await call('DELETE', `/api/users/${D}`, { token: tokD })).status, 204);
  check('abonelikler (kaldırılmış olanlar dahil), cihaz jetonları ve kullanıcı satırı silindi', [await count('subscriptions', D), await count('device_tokens', D), await count('users', D)], [0, 0, 0]);
  check('kimlik "silindi" olarak işaretlendi', await userStore.isDeleted(D), true);
  check('ESKİ ANAHTAR artık geçersiz: limits -> 401', (await call('GET', `/api/users/${D}/limits`, { token: tokD })).status, 401);
  check('  ... liste -> 401', (await call('GET', `/api/products?userId=${D}`, { token: tokD })).status, 401);
  check('  ... hesap geri DOĞMADI (kullanıcı satırı yok)', await count('users', D), 0);
  check('  ... ikinci silme isteği de 401 (zaten silinmiş)', (await call('DELETE', `/api/users/${D}`, { token: tokD })).status, 401);
  check('silinen hesabın cihazına bildirim gitmez (jeton yok)', (await deviceTokenStore.listByUser(D)).length, 0);

  check('diğer kullanıcı (E) etkilenmedi: abonelik + jeton + oturum', [await count('subscriptions', E), await count('device_tokens', E), (await call('GET', `/api/users/${E}/limits`, { token: tokE })).status], [1, 1, 200]);
  check('ortak ürün kaydı (paylaşımlı) silinmedi', (await trackedTargetStore.findById(dTarget.id)) !== null, true);

  const hook = await call('POST', '/webhooks/revenuecat', { body: { event: { type: 'INITIAL_PURCHASE', app_user_id: D } } });
  check('silinmiş hesap için RevenueCat olayı: 200 ama hesabı geri doğurmaz', [hook.status, hook.json.ignored, await count('users', D)], [200, 'ACCOUNT_DELETED', 0]);

  const fresh = await call('POST', '/api/auth/register');
  check('silmeden sonra uygulama yeni kimlikle sıfırdan başlar', [fresh.status, fresh.json.userId !== D, (await call('GET', `/api/users/${fresh.json.userId}/limits`, { token: fresh.json.token })).json.isPremium], [201, true, false]);

  const { deleteSubscriber } = require('./billing/revenuecat');
  const savedKey = process.env.REVENUECAT_SECRET_KEY;
  delete process.env.REVENUECAT_SECRET_KEY;
  check('RevenueCat anahtarı yoksa en iyi çaba atlanır (silmeyi engellemez)', await deleteSubscriber('x'), { ok: false, reason: 'NOT_CONFIGURED' });
  process.env.REVENUECAT_SECRET_KEY = 'rc-test';
  const realFetch = global.fetch;
  const rcCalls = [];
  const rcReply = (status) => { global.fetch = async (url, init) => { rcCalls.push([init.method, url, init.headers.Authorization]); return { ok: status < 300, status }; }; };
  rcReply(200);
  check('RevenueCat müşteri kaydı silinir (DELETE /v1/subscribers/<id>)', [await deleteSubscriber('a/b'), rcCalls[0]], [{ ok: true }, ['DELETE', 'https://api.revenuecat.com/v1/subscribers/a%2Fb', 'Bearer rc-test']]);
  rcReply(404);
  check('RevenueCat 404 (kullanıcıyı hiç görmemiş) başarı sayılır', await deleteSubscriber('x'), { ok: true });
  rcReply(500);
  check('RevenueCat 500 -> hata sonucu, istisna yok', await deleteSubscriber('x'), { ok: false, reason: 'HTTP_500' });
  global.fetch = async () => { throw new TypeError('ağ'); };
  check('ağ hatası -> hata sonucu, istisna yok', await deleteSubscriber('x'), { ok: false, reason: 'NETWORK' });
  global.fetch = realFetch;
  if (savedKey === undefined) delete process.env.REVENUECAT_SECRET_KEY; else process.env.REVENUECAT_SECRET_KEY = savedKey;

  console.log('\n--- 9) trust proxy: vekil arkasında doğru istemci IP\'si (sahte başlığa karşı güvenli)');
  const { trustProxyHops, applyTrustProxy } = require('./config');
  const expressLib = require('express');
  const ipOf = async (value, xff) => {
    const probe = expressLib();
    applyTrustProxy(probe, value);
    probe.get('/ip', (req, res) => res.json({ ip: req.ip }));
    const srv = await new Promise((resolve) => { const s = probe.listen(0, () => resolve(s)); });
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/ip`, { headers: xff ? { 'X-Forwarded-For': xff } : {} });
    srv.close();
    return (await r.json()).ip.replace('::ffff:', '');
  };
  check('tanımsız: başlık yok sayılır (bağlantı adresi)', await ipOf(undefined, '9.9.9.9'), '127.0.0.1');
  check('0: başlık yok sayılır', await ipOf('0', '9.9.9.9'), '127.0.0.1');
  check('1 vekil: vekilin eklediği son adres', await ipOf('1', '9.9.9.9'), '9.9.9.9');
  check('1 vekil: istemci başa sahte adres eklese de vekilin gördüğü alınır', await ipOf('1', '6.6.6.6, 9.9.9.9'), '9.9.9.9');
  check('2 vekil: bir önceki adres', await ipOf('2', '6.6.6.6, 9.9.9.9'), '6.6.6.6');
  for (const bad of ['true', 'yes', '-1', '1.5', '99', 'abc']) {
    check(`geçersiz değer reddedilir: ${bad}`, (() => { try { trustProxyHops(bad); return 'ok'; } catch { return 'hata'; } })(), 'hata');
  }
  check('boş değer = vekil yok', trustProxyHops(''), 0);

  server.close();
  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
