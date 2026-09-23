// Güvenlik gerileme testleri (izole test DB'si + Redis gerekir; perf/lib.js koruması).
// Her madde, canlı testte gösterilen bir saldırının artık İŞLEMEDİĞİNİ doğrular.
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const express = require('express');
const pino = require('pino');
const { db, reset } = require('./perf/lib');

// routes/products import edilmeden ÖNCE sayfa çekimini ve kuyruğu değiştir (canlı istek / worker yok).
const ZARA_URL = 'https://www.zara.com/tr/tr/aaron-levine-x-zara-uzun-kollu-t-shirt-p01887320.html';
const REAL_NAME = 'AARON LEVINE X ZARA UZUN KOLLU T-SHIRT';
const FAKE_NAME = 'ACIL: hesabini dogrula -> evil.example/login';
const REAL_HTML = fs.readFileSync(path.join(__dirname, 'fixtures/zara-aaron-levine-tshirt.html'), 'utf8');
const POISON_HTML = REAL_HTML.split(REAL_NAME).join(FAKE_NAME);
require('./scraper/fetchHtml').fetchHtml = async () => ({ html: REAL_HTML, source: 'stub' });
let lastScrapeJob = null;
const { scrapeQueue } = require('./queue/scrapeQueue');
scrapeQueue.add = async (_name, data) => {
  lastScrapeJob = data;
  return { waitUntilFinished: async () => ({ error: { status: 502, body: { error: 'FETCH_FAILED' } } }) };
};

const { detectBrand } = require('./scraper/registry');
const { createRequestLogger, scrubUrl } = require('./middleware/requestLog');
const { loggerOptions } = require('./logger');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}
async function serve(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const post = (base, p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

(async () => {
  console.log('--- 1) detectBrand: yalnızca http(s)');
  check('https marka URL\'i kabul', !!detectBrand('https://www.zara.com/tr/tr/x-p1.html'), true);
  check('http marka URL\'i kabul', !!detectBrand('http://www.zara.com/x'), true);
  for (const bad of ['javascript://www.zara.com/%0Aalert(1)', 'file://www.zara.com/C:/Windows/win.ini', 'ftp://www.zara.com/x', 'data://www.zara.com/x', 'https://www.zara.com.evil.com/x', 'https://user:pw@www.zara.com@evil.com/', 'not a url']) {
    check(`reddedilir: ${bad.slice(0, 44)}`, detectBrand(bad), null);
  }

  console.log('\n--- 2) log: kimlik başlıkları ve userId maskeleniyor');
  let out = '';
  const sink = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
  const logApp = express();
  // Seviye info'ya SABİT: ortamdaki LOG_LEVEL=fatal/warn ise hiçbir satır yazılmaz ve
  // aşağıdaki "log'da YOK" kontrolleri boş yere geçerdi.
  logApp.use(createRequestLogger(pino({ ...loggerOptions, level: 'info' }, sink)));
  logApp.get('/api/products', (_req, res) => res.json([]));
  logApp.get('/api/users/:userId/limits', (_req, res) => res.json({}));
  const logSrv = await serve(logApp);
  const USER = 'f8447412-8155-46c1-b04f-2e0a77aa82ea';
  await fetch(`${logSrv.base}/api/products?userId=${USER}`, { headers: { Authorization: 'Bearer SIR-DEGER-12345', Cookie: 'session=GIZLI-COOKIE' } });
  await fetch(`${logSrv.base}/api/users/${USER}/limits`);
  await new Promise((r) => setTimeout(r, 200));
  logSrv.close();
  check('sağlık: 2 istek logu yazıldı (aksi halde aşağıdaki "YOK" kontrolleri anlamsız)', out.split('\n').filter((l) => l.includes('request completed')).length, 2);
  check('Authorization değeri log\'da YOK', out.includes('SIR-DEGER-12345'), false);
  check('Cookie değeri log\'da YOK', out.includes('GIZLI-COOKIE'), false);
  check('tam userId log\'da YOK', out.includes(USER), false);
  check('userId ilk 6 karakter + maske', out.includes('f84474***'), true);
  check('istek yolu hâlâ loglanıyor', out.includes('/api/users/f84474***/limits') && out.includes('"method":"GET"'), true);
  check('scrubUrl yalnızca kimliği maskeler', scrubUrl(`/api/products?userId=${USER}&x=1`), '/api/products?userId=f84474***&x=1');

  await reset();

  console.log('\n--- 3) istemci HTML\'i (varsayılan KAPALI): paylaşılan hedef zehirlenemez');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/products', require('./routes/products'));
  const api = await serve(app);
  delete process.env.ALLOW_CLIENT_HTML;

  const r1 = await post(api.base, '/api/products/resolve', { url: ZARA_URL, html: POISON_HTML });
  check('resolve: sunucu sayfayı KENDİ çekti', r1.json.htmlSource, 'stub');
  check('resolve: sahte ad yansımadı', r1.json.name, REAL_NAME);
  lastScrapeJob = null;
  await post(api.base, '/api/products', { userId: 'attacker', url: ZARA_URL, sku: '01887320-712-2', html: POISON_HTML });
  check('POST /products: html kuyruk işine GİRMEDİ', lastScrapeJob && lastScrapeJob.htmlOverride, undefined);

  console.log('\n--- 3b) ALLOW_CLIENT_HTML=1 (yalnızca yerel geliştirme): eski akış çalışır');
  process.env.ALLOW_CLIENT_HTML = '1';
  const r2 = await post(api.base, '/api/products/resolve', { url: ZARA_URL, html: POISON_HTML });
  check('resolve: istemci HTML\'i kullanıldı', r2.json.htmlSource, 'client');
  check('resolve: istemci HTML\'inden gelen ad', r2.json.name, FAKE_NAME);
  lastScrapeJob = null;
  await post(api.base, '/api/products', { userId: 'dev', url: ZARA_URL + '?dev=1', sku: '01887320-712-2', html: POISON_HTML });
  check('POST /products: html kuyruk işine girdi (bilinçli açık)', lastScrapeJob && lastScrapeJob.htmlOverride === POISON_HTML, true);
  delete process.env.ALLOW_CLIENT_HTML;
  api.close();

  console.log('\n--- 4) webhook: prod\'da secret yoksa KAPALI, karşılaştırma sabit zamanlı, dev davranışı korunur');
  const wapp = express();
  wapp.use(express.json());
  wapp.use('/webhooks', require('./routes/webhooks'));
  const wh = await serve(wapp);
  const purchase = (id) => ({ event: { type: 'INITIAL_PURCHASE', app_user_id: id } });
  const isPremium = async (id) => (await db.query('SELECT is_premium FROM users WHERE user_id = $1', [id])).rows[0]?.is_premium ?? null;
  const savedEnv = { node: process.env.NODE_ENV, secret: process.env.REVENUECAT_WEBHOOK_SECRET };

  delete process.env.REVENUECAT_WEBHOOK_SECRET;
  process.env.NODE_ENV = 'production';
  check('prod + secret YOK + başlık YOK -> 401', (await post(wh.base, '/webhooks/revenuecat', purchase('w1'))).status, 401);
  check('  ... ve kullanıcı premium OLMADI', await isPremium('w1'), null);

  delete process.env.NODE_ENV;
  check('NODE_ENV YOK + secret YOK -> 401 (fail-closed)', (await post(wh.base, '/webhooks/revenuecat', purchase('w2'))).status, 401);
  process.env.NODE_ENV = 'prod';
  check('NODE_ENV yazım hatası ("prod") + secret YOK -> 401', (await post(wh.base, '/webhooks/revenuecat', purchase('w2'))).status, 401);
  check('  ... ve kullanıcı premium OLMADI', await isPremium('w2'), null);
  process.env.NODE_ENV = 'development';
  check('development + secret YOK -> 200 (açık geliştirme davranışı)', (await post(wh.base, '/webhooks/revenuecat', purchase('w2'))).status, 200);
  delete process.env.NODE_ENV;

  process.env.REVENUECAT_WEBHOOK_SECRET = 'dogru-secret-degeri';
  check('secret var + başlık YOK -> 401', (await post(wh.base, '/webhooks/revenuecat', purchase('w3'))).status, 401);
  check('secret var + yanlış (aynı uzunluk) -> 401', (await post(wh.base, '/webhooks/revenuecat', purchase('w3'), { Authorization: 'Bearer yanlis-secret-degeri' })).status, 401);
  check('secret var + yanlış (farklı uzunluk) -> 401', (await post(wh.base, '/webhooks/revenuecat', purchase('w3'), { Authorization: 'Bearer x' })).status, 401);
  check('  ... ve kullanıcı premium OLMADI', await isPremium('w3'), null);
  check('secret doğru -> 200', (await post(wh.base, '/webhooks/revenuecat', purchase('w4'), { Authorization: 'Bearer dogru-secret-degeri' })).status, 200);
  check('  ... ve kullanıcı premium oldu', await isPremium('w4'), true);
  process.env.NODE_ENV = 'production';
  check('prod + secret doğru -> 200', (await post(wh.base, '/webhooks/revenuecat', purchase('w5'), { Authorization: 'Bearer dogru-secret-degeri' })).status, 200);
  if (savedEnv.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv.node;
  if (savedEnv.secret === undefined) delete process.env.REVENUECAT_WEBHOOK_SECRET; else process.env.REVENUECAT_WEBHOOK_SECRET = savedEnv.secret;
  wh.close();

  console.log('\n--- 5) dev-premium ucu: yalnızca NODE_ENV=development|test iken açık (fail-closed)');
  const uapp = express();
  uapp.use(express.json());
  uapp.use('/api/users', require('./routes/users'));
  const usr = await serve(uapp);
  const savedNode = process.env.NODE_ENV;
  for (const [env, expected] of [[undefined, 403], ['prod', 403], ['production', 403], ['development', 200]]) {
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
    const id = `dev-${env || 'unset'}`;
    check(`NODE_ENV=${env} -> POST /premium ${expected}`, (await post(usr.base, `/api/users/${id}/premium`, { isPremium: true })).status, expected);
    check('  ... premium durumu', await isPremium(id), expected === 200 ? true : null);
  }
  if (savedNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNode;
  usr.close();

  console.log('\n--- 6) sandbox satın almaları: canlıda premium vermez (billing/revenuecat.js)');
  const { shouldIgnoreEvent, hasActiveEntitlement } = require('./billing/revenuecat');
  const future = new Date(Date.now() + 86400000).toISOString();
  const subscriber = (isSandbox) => ({
    entitlements: { pro: { product_identifier: 'premium_monthly', expires_date: future } },
    subscriptions: { premium_monthly: { is_sandbox: isSandbox } },
  });
  const nodeBefore = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  check('prod: SANDBOX olayı yok sayılır', shouldIgnoreEvent({ environment: 'SANDBOX' }), true);
  check('prod: PRODUCTION olayı işlenir', shouldIgnoreEvent({ environment: 'PRODUCTION' }), false);
  check('prod: sandbox entitlement premium SAYILMAZ', hasActiveEntitlement(subscriber(true)), false);
  check('prod: gerçek entitlement premium sayılır', hasActiveEntitlement(subscriber(false)), true);
  check('prod: süresi dolmuş entitlement sayılmaz', hasActiveEntitlement({ entitlements: { pro: { product_identifier: 'p', expires_date: '2000-01-01T00:00:00Z' } }, subscriptions: { p: { is_sandbox: false } } }), false);
  check('prod: sandbox lifetime (non_subscriptions) SAYILMAZ', hasActiveEntitlement({ entitlements: { pro: { product_identifier: 'life', expires_date: null } }, non_subscriptions: { life: [{ is_sandbox: true }] } }), false);
  check('prod: gerçek lifetime sayılır', hasActiveEntitlement({ entitlements: { pro: { product_identifier: 'life', expires_date: null } }, non_subscriptions: { life: [{ is_sandbox: false }] } }), true);
  process.env.NODE_ENV = 'development';
  check('development: sandbox olayı işlenir', shouldIgnoreEvent({ environment: 'SANDBOX' }), false);
  check('development: sandbox entitlement sayılır', hasActiveEntitlement(subscriber(true)), true);
  process.env.NODE_ENV = 'production';
  process.env.REVENUECAT_WEBHOOK_SECRET = 'dogru-secret-degeri';
  const wapp2 = express();
  wapp2.use(express.json());
  wapp2.use('/webhooks', require('./routes/webhooks'));
  const wh2 = await serve(wapp2);
  const auth = { Authorization: 'Bearer dogru-secret-degeri' };
  check('prod: SANDBOX INITIAL_PURCHASE -> 200 ama premium OLMADI', (await post(wh2.base, '/webhooks/revenuecat', { event: { type: 'INITIAL_PURCHASE', app_user_id: 'sbx1', environment: 'SANDBOX' } }, auth)).status, 200);
  check('  ... premium durumu', await isPremium('sbx1'), null);
  await post(wh2.base, '/webhooks/revenuecat', { event: { type: 'INITIAL_PURCHASE', app_user_id: 'real1', environment: 'PRODUCTION' } }, auth);
  await post(wh2.base, '/webhooks/revenuecat', { event: { type: 'EXPIRATION', app_user_id: 'real1', environment: 'SANDBOX' } }, auth);
  check("prod: SANDBOX EXPIRATION gerçek premium'u KAPATMAZ", await isPremium('real1'), true);
  wh2.close();
  delete process.env.REVENUECAT_WEBHOOK_SECRET;
  if (nodeBefore === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeBefore;

  console.log("\n--- 7) push token: başka kullanıcının token'ı taşınamaz");
  const deviceTokenStore = require('./store/deviceTokenStore');
  const TOKEN = 'ExponentPushToken[kurban-cihazi]';
  await deviceTokenStore.upsert({ userId: 'kurban', expoPushToken: TOKEN, platform: 'ios' });
  await deviceTokenStore.upsert({ userId: 'saldirgan', expoPushToken: TOKEN, platform: 'ios' });
  check("kurban token'ını HÂLÂ alıyor", (await deviceTokenStore.listByUser('kurban')).map((t) => t.expoPushToken), [TOKEN]);
  await deviceTokenStore.upsert({ userId: 'kurban', expoPushToken: TOKEN, platform: 'android' });
  check('aynı kullanıcı tekrar kaydolunca yinelenmez', (await deviceTokenStore.listByUser('kurban')).length, 1);
  check('  ... ve platform güncellenir', (await deviceTokenStore.listByUser('kurban'))[0].platform, 'android');

  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
