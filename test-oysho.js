const fs = require('fs');
const path = require('path');
const { parseOyshoProduct } = require('./scraper/brands/oysho');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

const html = fs.readFileSync(path.join(__dirname, 'fixtures/oysho-ceket.html'), 'utf8');
const product = parseOyshoProduct(
  html,
  'https://www.oysho.com/tr/fellex-aerogel-dolgulu-kısa-ceket-l35114492?colorId=735&pelement=206318962&categoryId=1010414206'
);

check('productId', product.productId, '35114492');
check('isim (çoklu "|" son eki temizlendi, og:title\'dan)', product.name, 'FELLEX® AEROGEL dolgulu kısa ceket');
check('renk', product.variants[0].color, 'BORDO');
check('fiyat (indirimli/güncel fiyat okundu)', product.variants[0].price, 1990);
check('para birimi', product.variants[0].currency, 'TRY');
check(
  'bedenler',
  product.variants.map((v) => v.size),
  ['XS', 'S', 'M', 'L', 'XL']
);
check(
  'stok durumları (gerçek few-units/out-of-stock-selectable verisi)',
  product.variants.map((v) => v.availability),
  ['low_stock', 'out_of_stock', 'out_of_stock', 'in_stock', 'in_stock']
);
check('kardeş renk sayısı (sadece seçili renk güvenilir)', product.relatedColors.length, 1);
check(
  'seçili renk',
  { name: product.relatedColors[0].name, colorId: product.relatedColors[0].colorId, selected: product.relatedColors[0].selected },
  { name: 'BORDO', colorId: '735', selected: true }
);

console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
process.exit(ok ? 0 : 1);
