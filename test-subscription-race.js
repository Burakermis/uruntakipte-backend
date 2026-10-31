// Abonelik ekleme/çıkarma yarış durumları (izole test DB'si + Redis gerekir): eşzamanlı istekler ücretsiz limiti ve
// 48 saatlik bekleme kuralını aşamaz, aynı (ürün, beden) için mükerrer satır oluşmaz (bkz. subscriptionStore.withUserLock,
// migration 004). Canlı siteye istek atmaz: hedefler önceden DB'ye konur, böylece sayfa çekimi/kuyruk devreye girmez.
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'test-secret-test-secret-test-secret-1234';
const fs = require('fs');
const path = require('path');
const { db, reset } = require('./perf/lib');
const { normalizeTrackingUrl } = require('./scraper/normalizeUrl');
const trackedTargetStore = require('./store/trackedTargetStore');
const subscriptionStore = require('./store/subscriptionStore');
const userStore = require('./store/userStore');
const { resolveProductFromHtml } = require('./scraper/registry');
const app = require('./server');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/mango-denim-ceket.html'), 'utf8');
const urlFor = (i) => `https://shop.mango.com/tr/tr/p/erkek/ceket/ceket/race-${i}/3708440${i}/30/00`;

(async () => {
  await reset();
  const variants = resolveProductFromHtml({ url: urlFor(0), html: FIXTURE }).variants.map((v) => ({ ...v }));
  const targets = [];
  for (let i = 1; i <= 8; i++) {
    targets.push(await trackedTargetStore.create({ urlKey: normalizeTrackingUrl(urlFor(i)), brand: 'mango', url: urlFor(i), name: `Race ${i}`, canonicalUrl: urlFor(i), variants }));
  }
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const register = async () => (await fetch(`${base}/api/auth/register`, { method: 'POST' })).json();
  const headers = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  const add = (u, i, sku = variants[0].sku) => fetch(`${base}/api/products`, { method: 'POST', headers: headers(u.token), body: JSON.stringify({ userId: u.userId, url: urlFor(i), sku }) });
  const del = (u, subId) => fetch(`${base}/api/products/${subId}?userId=${u.userId}`, { method: 'DELETE', headers: headers(u.token) });
  const activeProducts = async (u) => (await db.query('SELECT count(DISTINCT target_id)::int n FROM subscriptions WHERE user_id=$1 AND active', [u.userId])).rows[0].n;
  const tally = (rs) => rs.map((r) => r.status).sort().join(',');

  console.log('--- 1) ücretsiz limit (3 ürün): 8 eşzamanlı ekleme');
  const free = await register();
  const rs = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => add(free, i)));
  check('tam 3 başarılı, 5 reddedildi (PREMIUM_LIMIT_REACHED)', tally(rs), '201,201,201,403,403,403,403,403');
  check('veritabanında 3 aktif ürün', await activeProducts(free), 3);

  console.log('\n--- 2) çift dokunma: aynı ürün+beden için 5 eşzamanlı istek');
  const dbl = await register();
  const rd = await Promise.all([1, 2, 3, 4, 5].map(() => add(dbl, 1)));
  const bodies = await Promise.all(rd.map((r) => r.json()));
  check('hepsi başarılı', tally(rd), '201,201,201,201,201');
  check('TEK abonelik satırı', (await db.query('SELECT count(*)::int n FROM subscriptions WHERE user_id=$1', [dbl.userId])).rows[0].n, 1);
  check('yalnızca biri "yeni", dördü alreadyTracked', bodies.filter((b) => b.alreadyTracked).length, 4);

  console.log('\n--- 3) aynı ürünün farklı bedenleri eşzamanlı: tek slot sayılır');
  const sizes = await register();
  const skus = variants.slice(0, 4).map((v) => v.sku);
  const rz = await Promise.all(skus.map((sku) => add(sizes, 1, sku)));
  check('4 beden de eklendi', tally(rz), '201,201,201,201');
  check('ama tek ürün (slot) sayıldı', await activeProducts(sizes), 1);
  const more = await Promise.all([2, 3, 4].map((i) => add(sizes, i)));
  check('2 ürün daha eklenebilir, 4. ürün reddedilir', tally(more), '201,201,403');

  console.log('\n--- 4) premium kullanıcı sınırsız');
  const prem = await register();
  await userStore.setPremium(prem.userId, true);
  const rp = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => add(prem, i)));
  check('8 eşzamanlı ekleme hepsi başarılı', tally(rp), '201,201,201,201,201,201,201,201');
  check('8 aktif ürün', await activeProducts(prem), 8);

  console.log('\n--- 5) çıkar + ekle eşzamanlı: 48 saatlik bekleme kuralı atlatılamaz');
  const orders = new Set();
  for (let round = 0; round < 4; round++) {
    const u = await register();
    const subs = [];
    for (const i of [1, 2, 3]) subs.push(await (await add(u, i)).json());
    const [rDel, rAdd] = await Promise.all([del(u, subs[0].id), add(u, 4)]);
    orders.add(`${rDel.status}/${rAdd.status}`);
    check(`tur ${round + 1}: yeni ürün eklenemedi (silme ${rDel.status}, ekleme ${rAdd.status})`, [rDel.status, rAdd.status === 201], [204, false]);
    check(`tur ${round + 1}: hâlâ en fazla 2 ürün (silinen boş slot yeniden doldurulamadı)`, await activeProducts(u), 2);
  }

  console.log('\n--- 6) kilit kullanıcıya özel: bir kullanıcının kilidi diğerini bekletmez');
  const slow = await register();
  const other = await register();
  let release;
  const held = subscriptionStore.withUserLock(slow.userId, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((r) => setTimeout(r, 100));
  const started = Date.now();
  const rOther = await add(other, 1);
  check('başka kullanıcının isteği kilit sürerken tamamlandı', [rOther.status, Date.now() - started < 2000], [201, true]);
  release();
  await held;

  console.log('\n--- 7) store seviyesi: create idempotent, UNIQUE kısıt var');
  const t = targets[0];
  const a = await subscriptionStore.create({ userId: 'store-u', targetId: t.id, sku: 'x', notifyOnPriceDrop: true, lastNotifiedPrice: 10 });
  const b = await subscriptionStore.create({ userId: 'store-u', targetId: t.id, sku: 'x', notifyOnPriceDrop: false, lastNotifiedPrice: 20 });
  check('aynı satır (hata yok, ikinci satır yok)', [a.id === b.id, (await db.query("SELECT count(*)::int n FROM subscriptions WHERE user_id='store-u'")).rows[0].n], [true, 1]);
  check('ikinci çağrı değerleri günceller', [b.notifyOnPriceDrop, b.lastNotifiedPrice], [false, 20]);
  let rejected = false;
  try {
    await db.query("INSERT INTO subscriptions (user_id, target_id, sku) VALUES ('store-u', $1, 'x')", [t.id]);
  } catch (err) {
    rejected = err.code === '23505';
  }
  check('doğrudan mükerrer INSERT veritabanınca reddedilir (23505)', rejected, true);

  console.log('\n--- 8) migration 004: mevcut mükerrerler temizlenir (aktif olan korunur)');
  await db.query('DROP INDEX IF EXISTS idx_subscriptions_user_target_sku');
  const ins = (active, removed) => db.query("INSERT INTO subscriptions (user_id, target_id, sku, active, removed_at) VALUES ('dup-u', $1, 'k', $2, $3) RETURNING id", [t.id, active, removed ? new Date() : null]);
  const old = (await ins(false, true)).rows[0].id;
  const live = (await ins(true, false)).rows[0].id;
  await ins(false, true);
  await ins(false, true);
  await db.query("INSERT INTO subscriptions (user_id, target_id, sku) VALUES ('dup-other', $1, 'k')", [t.id]); // başka kullanıcı: dokunulmaz
  await db.query(fs.readFileSync(path.join(__dirname, 'store/migrations/004_unique_subscription.sql'), 'utf8'));
  const left = (await db.query("SELECT id, active FROM subscriptions WHERE user_id='dup-u'")).rows;
  check('grupta tek satır kaldı: aktif olan', [left.length, left[0].id === live, left[0].active, left[0].id === old], [1, true, true, false]);
  check('başka kullanıcının satırına dokunulmadı', (await db.query("SELECT count(*)::int n FROM subscriptions WHERE user_id='dup-other'")).rows[0].n, 1);
  check('UNIQUE kısıt geri geldi', (await db.query("SELECT count(*)::int n FROM pg_indexes WHERE indexname='idx_subscriptions_user_target_sku'")).rows[0].n, 1);

  server.close();
  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
