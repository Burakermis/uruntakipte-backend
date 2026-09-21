const fs = require('fs');
const path = require('path');
const { parseMangoProduct } = require('./scraper/brands/mango');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

const html = fs.readFileSync(path.join(__dirname, 'fixtures/mango-denim-ceket.html'), 'utf8');
const product = parseMangoProduct(
  html,
  'https://shop.mango.com/tr/tr/p/erkek/ceket/ceket/fitilli-kadife-yakalı-denim-ceket/37084403/30/00'
);

check('productId', product.productId, '37084403');
check('isim (og:title son eki temizlendi)', product.name, 'Fitilli kadife yakalı denim ceket');
check('renk', product.variants[0].color, 'Kahverengi');
check('fiyat', product.variants[0].price, 3699.99);
check('para birimi', product.variants[0].currency, 'TRY');
check(
  'bedenler',
  product.variants.map((v) => v.size),
  ['S', 'M', 'L', 'XL', 'XXL']
);
check('tüm bedenler stokta (sinyal yok -> varsayılan)', product.variants.every((v) => v.availability === 'in_stock'), true);
check('kardeş renk sayısı', product.relatedColors.length, 2);
check(
  'kardeş renkler',
  product.relatedColors.map((c) => ({ name: c.name, colorId: c.colorId, selected: c.selected })),
  [
    { name: 'Lacivert', colorId: '56', selected: false },
    { name: 'Kahverengi', colorId: '30', selected: true },
  ]
);

console.log('\n--- eski biçimli URL (sitede yeni biçime yönlenen, istek URL\'inde kod yok) ---');
const NEW_URL = 'https://shop.mango.com/tr/tr/p/erkek/ceket/ceket/fitilli-kadife-yakalı-denim-ceket/37084403/30/00';
const legacy = parseMangoProduct(
  html,
  'https://shop.mango.com/tr/tr/p/erkek/ceket/fitilli-kadife-yakali-denim-ceket_37084403'
);
check('productId URL değil, canonical\'dan', legacy.productId, '37084403');
check('SKU yeni biçimle aynı', legacy.variants[0].sku, '37084403-30-S');
check('kalıcı URL yeni biçim (dedup + yönlendirmesiz tarama)', legacy.canonicalUrl, NEW_URL);
check('yeni biçimli URL\'de davranış değişmedi', product.canonicalUrl, NEW_URL);
check('yeni biçimli URL\'de SKU', product.variants[0].sku, '37084403-30-S');

console.log('\n--- indirimli ürün + tükenmiş beden (gerçek örnek) ---');
const discountHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures/mango-polo-kazak-discount.html'),
  'utf8'
);
const discounted = parseMangoProduct(
  discountHtml,
  'https://shop.mango.com/tr/tr/p/erkek/hirka-ve-kazak/polo-yaka-tisort/100-merinos-yunu-polo-kazak/27051283/35/00'
);
check('indirimli fiyat (finalPrice sınıfı doğru okundu)', discounted.variants[0].price, 1699.99);
check(
  'bedenler',
  discounted.variants.map((v) => v.size),
  ['S', 'M', 'L', 'XL', 'XXL']
);
check(
  'stok durumları (XL gerçekten tükendi)',
  discounted.variants.map((v) => v.availability),
  ['in_stock', 'in_stock', 'in_stock', 'out_of_stock', 'in_stock']
);
check('renk seçici yoksa varsayılan renk', discounted.variants[0].color, 'Tek Renk');

console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
process.exit(ok ? 0 : 1);
