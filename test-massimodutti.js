const fs = require('fs');
const path = require('path');
const { parseMassimoDuttiProduct } = require('./scraper/brands/massimodutti');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

// Bu fixture DOM DEĞİL — gerçek bir canlı sayfadan (Playwright ile) çekilip
// içinden çıkarılan Angular TransferState JSON'ının (#mdfrontw-state) aynen
// gömülü hâli. DOM tabanlı beden seçici gerçek tarayıcıda hiç render
// olmadığı için (bkz. massimodutti.js'deki not) bu, tek güvenilir kaynak.
const html = fs.readFileSync(path.join(__dirname, 'fixtures/massimodutti-tshirt.html'), 'utf8');
const product = parseMassimoDuttiProduct(
  html,
  'https://www.massimodutti.com/tr/100-pamuklu-uzun-kollu-dugmeli-yaka-tshirt-l00778176'
);

check('productId', product.productId, '00778176');
check('isim', product.name, '%100 pamuklu uzun kollu düğmeli yaka t-shirt');
check('varyant sayısı (3 renk x 4 beden)', product.variants.length, 12);
check(
  'renkler',
  [...new Set(product.variants.map((v) => v.color))],
  ['KOYU LACİVERT', 'Beyaz', 'Çikolata kahverengi']
);
check(
  'bir rengin bedenleri',
  product.variants.filter((v) => v.color === 'KOYU LACİVERT').map((v) => v.size),
  ['S', 'M', 'L', 'XL']
);
check('fiyat (kuruştan TL\'ye çevrildi)', product.variants[0].price, 3000);
check('para birimi', product.variants[0].currency, 'TRY');
check('tüm varyantlar stokta (gerçek isBuyable=true verisi)', product.variants.every((v) => v.availability === 'in_stock'), true);
check(
  'sku doğrudan Massimo Dutti\'nin kendi size.sku alanından geliyor',
  product.variants[0].sku,
  '62090095'
);

console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
process.exit(ok ? 0 : 1);
