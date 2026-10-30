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

  server.close();
  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
