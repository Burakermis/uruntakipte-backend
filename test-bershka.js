const fs = require('fs');
const path = require('path');
const { parseBershkaProduct } = require('./scraper/brands/bershka');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

const html = fs.readFileSync(path.join(__dirname, 'fixtures/bershka-baskili-tshirt.html'), 'utf8');
const product = parseBershkaProduct(
  html,
  'https://www.bershka.com/tr/baskili-uzun-kollu-dugmeli-yaka-tisort-c0p227531249.html?colorId=711'
);

check('productId', product.productId, '227531249');
check('isim (og:title son eki temizlendi)', product.name, 'Baskılı uzun kollu düğmeli yaka tişört');
check('renk', product.variants[0].color, 'Kum rengi');
check('fiyat', product.variants[0].price, 1790);
check('para birimi', product.variants[0].currency, 'TRY');
check('beden sayısı', product.variants.length, 5);
check(
  'bedenler',
  product.variants.map((v) => v.size),
  ['XS', 'S', 'M', 'L', 'XL']
);
check('tüm bedenler stokta (sinyal yok -> varsayılan)', product.variants.every((v) => v.availability === 'in_stock'), true);
check('kardeş renk sayısı', product.relatedColors.length, 2);
check(
  'kardeş renkler',
  product.relatedColors.map((c) => ({ name: c.name, colorId: c.colorId, selected: c.selected })),
  [
    { name: 'Kum rengi', colorId: '711', selected: true },
    { name: 'Koyu gri', colorId: '809', selected: false },
  ]
);

console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
process.exit(ok ? 0 : 1);
