const fs = require('fs');
const path = require('path');
const { parseHmProduct } = require('./scraper/brands/hm');

const html = fs.readFileSync(path.join(__dirname, 'fixtures/hm-product-snippet.html'), 'utf8');
const url = 'https://www2.hm.com/tr_tr/productpage.1336969003.html';
const result = parseHmProduct(html, url);

console.log(JSON.stringify(result, null, 2));

console.log('\n--- doğrulama ---');
const checks = [
  ['productId', result.productId, '1336969003'],
  ['name (sondaki "- H&M TR" son eki temizlendi)', result.name, 'Regular Fit Tişört - Beyaz'],
  ['variant sayısı', result.variants.length, 5],
  ['S renk', result.variants[0].color, 'Beyaz/Koyu gri/Siyah'],
  ['S fiyat', result.variants[0].price, 1799],
  ['S stok', result.variants[0].availability, 'in_stock'],
  ['L stok (az sayıda)', result.variants[2].availability, 'low_stock'],
  ['XL stok (tükendi)', result.variants[3].availability, 'out_of_stock'],
  ['ilişkili renk sayısı', result.relatedColors.length, 2],
  ['ilişkili renk 1 adı', result.relatedColors[0].name, 'Beyaz/Koyu gri/Siyah'],
  ['ilişkili renk 1 seçili mi', result.relatedColors[0].selected, true],
  ['ilişkili renk 2 adı', result.relatedColors[1].name, 'Haki/Gri/Tozlu mavi'],
  ['ilişkili renk 2 url', result.relatedColors[1].url, 'https://www2.hm.com/tr_tr/productpage.1336969002.html'],
];

let ok = true;
for (const [label, actual, expected] of checks) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}
console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
process.exit(ok ? 0 : 1);
