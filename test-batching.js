// Gerçek Postgres'e karşı (izole test DB'si; perf/lib.js koruması). Performans için yaptığımız
// değişikliklerin DAVRANIŞI değiştirmediğini doğrular:
//  1) isPremium artık yazmıyor (satır güncellemesi yok, SERIAL sayacı tüketilmiyor) ama ilk görüşte kayıt açıyor
//  2) previousPrices (toplu) == previousPrice (tekil)
//  3) checker: fiyat geçmişine SADECE değişimde yazıyor (yeni varyant dahil), değişmeyende yazmıyor
//  4) GET /products (toplu sorgular) doğru şekli ve fiyat değişim yüzdesini dönüyor
const fs = require('fs');
const path = require('path');
const express = require('express');
const { db, reset, tableTupleStats } = require('./perf/lib');
const userStore = require('./store/userStore');
const trackedTargetStore = require('./store/trackedTargetStore');
const subscriptionStore = require('./store/subscriptionStore');
const priceHistoryStore = require('./store/priceHistoryStore');
const { resolveProductFromHtml } = require('./scraper/registry');

// checker'ı yüklemeden ÖNCE sayfa çekimini fixture ile değiştir (canlı siteye istek yok).
const MANGO_URL = 'https://shop.mango.com/tr/tr/p/erkek/ceket/ceket/fitilli-kadife-yakalı-denim-ceket/37084403/30/00';
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/mango-denim-ceket.html'), 'utf8');
require('./scraper/fetchHtml').fetchHtml = async () => ({ html: FIXTURE, source: 'test' });
const { checkTrackedTarget } = require('./checker');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}
const historyCount = async (targetId) => Number((await db.query('SELECT count(*) FROM price_history WHERE target_id = $1', [targetId])).rows[0].count);

(async () => {
  await reset();

  console.log('--- 1) isPremium: salt okuma');
  check('kayıtsız kullanıcı ücretsiz', await userStore.isPremium('yeni-kullanici'), false);
  check('ilk görüşte users satırı açıldı', Number((await db.query(`SELECT count(*) FROM users WHERE user_id = 'yeni-kullanici'`)).rows[0].count), 1);
  await userStore.setPremium('prem', true);
  const seqBefore = Number((await db.query('SELECT last_value FROM users_id_seq')).rows[0].last_value);
  const statsBefore = await tableTupleStats('users');
  for (let i = 0; i < 200; i++) {
    await userStore.isPremium('prem');
    await userStore.isPremium('yeni-kullanici');
  }
  const statsAfter = await tableTupleStats('users');
  const seqAfter = Number((await db.query('SELECT last_value FROM users_id_seq')).rows[0].last_value);
  check('400 isPremium çağrısı: users satırı güncellemesi', statsAfter.upd - statsBefore.upd, 0);
  check('400 isPremium çağrısı: SERIAL sayacı tüketilmedi', seqAfter - seqBefore, 0);
  check('premium kullanıcı hâlâ premium', await userStore.isPremium('prem'), true);

  console.log('\n--- 2) previousPrices (toplu) == previousPrice (tekil)');
  const mk = (n) => trackedTargetStore.create({ urlKey: `b-${n}`, brand: 'mango', url: `https://shop.mango.com/${n}`, name: n, variants: [{ sku: 's', color: 'c', size: 'M', price: 100, currency: 'TRY', availability: 'in_stock' }] });
  const tA = await mk('A'); // 110 -> 100 (önceki 110)
  const tB = await mk('B'); // hep 100 (önceki yok)
  const tC = await mk('C'); // 90 -> 100 -> 100 (önceki 90)
  const put = (t, price, minsAgo) => db.query(`INSERT INTO price_history (target_id, sku, price, availability, checked_at) VALUES ($1,'s',$2,'in_stock', now() - ($3 || ' minutes')::interval)`, [t.id, price, String(minsAgo)]);
  await put(tA, 110, 30); await put(tA, 100, 10);
  await put(tB, 100, 30); await put(tB, 100, 10);
  await put(tC, 90, 30); await put(tC, 100, 20); await put(tC, 100, 10);
  const pairs = [tA, tB, tC].map((t) => ({ targetId: t.id, sku: 's', currentPrice: 100 }));
  const batch = await priceHistoryStore.previousPrices(pairs);
  for (const p of pairs) {
    const single = await priceHistoryStore.previousPrice(p.targetId, p.sku, p.currentPrice);
    check(`hedef ${p.targetId}: toplu == tekil`, batch.get(`${p.targetId}|s`), single);
  }
  check('değerler', pairs.map((p) => batch.get(`${p.targetId}|s`)), [110, null, 90]);
  check('boş girdi', (await priceHistoryStore.previousPrices([])).size, 0);

  console.log('\n--- 3) checker: geçmişe SADECE değişimde yaz');
  const resolved = resolveProductFromHtml({ url: MANGO_URL, html: FIXTURE });
  const stored = resolved.variants.map((v) => ({ ...v }));
  stored[0].price = 1; // fiyat farklı -> değişmiş sayılmalı
  stored.splice(1, 1); // varyant yeni -> yazılmalı
  const target = await trackedTargetStore.create({ urlKey: 'chk', brand: 'mango', url: MANGO_URL, name: 'chk', variants: stored });
  check('başlangıçta geçmiş yok', await historyCount(target.id), 0);
  const r1 = await checkTrackedTarget(target);
  check('1. kontrol başarılı', r1.ok, true);
  check('1. kontrol: yalnızca değişen + yeni varyant yazıldı', await historyCount(target.id), 2);
  const r2 = await checkTrackedTarget(await trackedTargetStore.findById(target.id));
  check('2. kontrol başarılı', r2.ok, true);
  check('2. kontrol: değişim yok -> satır eklenmedi', await historyCount(target.id), 2);
  const after = await trackedTargetStore.findById(target.id);
  check('hedefin varyantları güncel (tümü sayfadan)', after.variants.length, resolved.variants.length);
  check('son başarılı kontrol zamanı yazıldı', after.lastCheckedAt !== null, true);

  console.log('\n--- 4) GET /products (toplu)');
  await subscriptionStore.create({ userId: 'u1', targetId: tA.id, sku: 's', notifyOnPriceDrop: true });
  await subscriptionStore.create({ userId: 'u1', targetId: tB.id, sku: 's', notifyOnPriceDrop: true });
  await subscriptionStore.create({ userId: 'u1', targetId: tC.id, sku: 'YOK', notifyOnPriceDrop: true }); // varyant yok -> listede olmamalı
  const app = express();
  app.use('/api/products', require('./routes/products'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const items = await (await fetch(`http://127.0.0.1:${server.address().port}/api/products?userId=u1`)).json();
  server.close();
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  check('2 kayıt (varyantı olmayan elendi)', items.length, 2);
  check('A: 110 -> 100 = %-9', byName.A.priceChangePercent, -9);
  check('B: değişim yok -> null', byName.B.priceChangePercent, null);
  check('A: alanlar', { lastPrice: byName.A.lastPrice, size: byName.A.size, brand: byName.A.brand, userId: byName.A.userId }, { lastPrice: 100, size: 'M', brand: 'mango', userId: 'u1' });
  const empty = await (async () => {
    const s2 = express(); s2.use('/api/products', require('./routes/products'));
    const srv = await new Promise((resolve) => { const s = s2.listen(0, () => resolve(s)); });
    const r = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/products?userId=kimse`)).json();
    srv.close();
    return r;
  })();
  check('aboneliği olmayan kullanıcı -> []', empty, []);

  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
