const fs = require('fs');
const path = require('path');
const { parseStradivariusProduct } = require('./scraper/brands/stradivarius');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

const html = fs.readFileSync(path.join(__dirname, 'fixtures/stradivarius-pantolon.html'), 'utf8');
const product = parseStradivariusProduct(
  html,
  'https://www.stradivarius.com/tr/desenli-hacimli-pantolon-l01214154?categoryId=1020727282&colorId=042&pelement=497002589'
);

check('productId', product.productId, '01214154');
check('isim (og:title son eki temizlendi)', product.name, 'Desenli hacimli pantolon');
check('renk', product.variants[0].color, 'Açık mavi');
check('fiyat (indirimli/güncel fiyat okundu)', product.variants[0].price, 520);
check('para birimi', product.variants[0].currency, 'TRY');
check(
  'bedenler',
  product.variants.map((v) => v.size),
  ['XXS', 'XS', 'S', 'M', 'L', 'XL']
);
check(
  'stok durumları (gerçek size-last-units/size-no-stock verisi)',
  product.variants.map((v) => v.availability),
  ['in_stock', 'in_stock', 'low_stock', 'out_of_stock', 'out_of_stock', 'out_of_stock']
);
check(
  'sku doğrudan data-sku özniteliğinden geliyor',
  product.variants.map((v) => v.sku),
  ['496982454', '502624808', '502624810', '496982448', '496982450', '496982440']
);
check('kardeş renk sayısı', product.relatedColors.length, 3);
check(
  'kardeş renkler',
  product.relatedColors.map((c) => ({ name: c.name, colorId: c.colorId, selected: c.selected })),
  [
    { name: 'Açık mavi', colorId: '042', selected: true },
    { name: 'Siyah', colorId: '001', selected: false },
    { name: 'Beyaz', colorId: '003', selected: false },
  ]
);

console.log('\n--- indirimsiz ürün (gerçek canlı testte yakalanan durum: #discount hiç yok) ---');
const noDiscountHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures/stradivarius-pantolon-no-discount.html'),
  'utf8'
);
const noDiscount = parseStradivariusProduct(
  noDiscountHtml,
  'https://www.stradivarius.com/tr/desenli-hacimli-pantolon-l01214154?colorId=042'
);
check('indirimsiz fiyat doğru okunuyor', noDiscount.variants[0].price, 950);

console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
process.exit(ok ? 0 : 1);
