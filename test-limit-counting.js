// Çalışan bir `node server.js` + `node queue/worker-process.js`'e karşı gerçek
// fetch() ile — aynı ürünün farklı bedenlerinin ücretsiz plan limitinde TEK
// slot sayıldığını doğrular (bkz. store/subscriptionStore.js'in
// countActiveByUser'ının artık DISTINCT target_id sayması).
//
// Fixture HTML'ini istemci gövdesiyle gönderdiği için sunucunun (API süreci)
// ALLOW_CLIENT_HTML=1 ile başlatılmış olması gerekir — o akış varsayılan olarak
// kapalı (bkz. routes/products.js clientHtmlAllowed). İzole bir test
// veritabanına karşı çalıştırın: test kullanıcıları/hedefleri oluşturur.
const fs = require('fs');

const BASE = 'http://localhost:4000/api';
const userId = `test-limit-${Date.now()}`;

async function resolveAndTrack(url, fixturePath, sku) {
  const html = fs.readFileSync(fixturePath, 'utf8');
  const res = await fetch(`${BASE}/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, url, sku, html }),
  });
  return { status: res.status, body: await res.json() };
}

async function resolveOnly(url, fixturePath) {
  const html = fs.readFileSync(fixturePath, 'utf8');
  const res = await fetch(`${BASE}/products/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, html }),
  });
  return res.json();
}

function assert(cond, message) {
  if (!cond) throw new Error(`FAIL: ${message}`);
  console.log(`OK: ${message}`);
}

async function main() {
  const zaraUrl = 'https://www.zara.com/tr/tr/aaron-levine-x-zara-uzun-kollu-t-shirt-p01887320.html';
  const zaraFixture = 'fixtures/zara-aaron-levine-tshirt.html';
  const resolved = await resolveOnly(zaraUrl, zaraFixture);
  const skus = resolved.colors[0].sizes.slice(0, 3).map((s) => s.sku);
  assert(skus.length === 3, `Zara fixture'ında en az 3 sku var (${skus.length})`);

  // 1) Aynı ürünün 3 farklı bedeni — üçü de başarılı olmalı (aynı target).
  for (const sku of skus) {
    const { status, body } = await resolveAndTrack(zaraUrl, zaraFixture, sku);
    assert(status === 201, `sku=${sku} eklendi (status=${status}, body=${JSON.stringify(body)})`);
  }

  // 2) /limits -> activeCount === 1 (3 değil) — asıl doğrulama noktası.
  const limits1 = await (await fetch(`${BASE}/users/${userId}/limits`)).json();
  assert(limits1.activeCount === 1, `3 beden sonrası activeCount === 1 (gerçek: ${limits1.activeCount})`);

  // 3) Farklı bir ürün (Mango) — 2. ürün, limit içinde (2/3).
  const mangoUrl = 'https://shop.mango.com/tr/test-limit-urun';
  const mangoFixture = 'fixtures/mango-denim-ceket.html';
  const mangoResolved = await resolveOnly(mangoUrl, mangoFixture);
  const mangoSku = mangoResolved.colors[0].sizes[0].sku;
  const add2 = await resolveAndTrack(mangoUrl, mangoFixture, mangoSku);
  assert(add2.status === 201, `2. ürün (Mango) eklendi (status=${add2.status})`);

  const limits2 = await (await fetch(`${BASE}/users/${userId}/limits`)).json();
  assert(limits2.activeCount === 2, `2. üründen sonra activeCount === 2 (gerçek: ${limits2.activeCount})`);

  // 4) 3. farklı ürün (Oysho) — limit dolar (3/3), ama hâlâ 201 (limit=3).
  const oyshoUrl = 'https://www.oysho.com/tr/test-limit-urun';
  const oyshoFixture = 'fixtures/oysho-ceket.html';
  const oyshoResolved = await resolveOnly(oyshoUrl, oyshoFixture);
  const oyshoSku = oyshoResolved.colors[0].sizes[0].sku;
  const add3 = await resolveAndTrack(oyshoUrl, oyshoFixture, oyshoSku);
  assert(add3.status === 201, `3. ürün (Oysho) eklendi (status=${add3.status})`);

  // 5) 4. farklı ürün (Stradivarius) — limit aşılır, 403 PREMIUM_LIMIT_REACHED.
  const stradUrl = 'https://www.stradivarius.com/tr/test-limit-urun';
  const stradFixture = 'fixtures/stradivarius-pantolon.html';
  const stradResolved = await resolveOnly(stradUrl, stradFixture);
  const stradSku = stradResolved.colors[0].sizes[0].sku;
  const add4 = await resolveAndTrack(stradUrl, stradFixture, stradSku);
  assert(
    add4.status === 403 && add4.body.error === 'PREMIUM_LIMIT_REACHED',
    `4. farklı ürün 403 PREMIUM_LIMIT_REACHED ile reddedildi (status=${add4.status}, error=${add4.body.error})`
  );

  // 6) Liste hâlâ (target,sku) başına bir satır döndürüyor — 5 satır
  // (3 Zara beden + 1 Mango + 1 Oysho), liste şekli değişmedi.
  const list = await (await fetch(`${BASE}/products?userId=${userId}`)).json();
  assert(list.length === 5, `Liste hâlâ satır bazlı: 5 kayıt (gerçek: ${list.length})`);

  console.log('\nTüm testler geçti.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
