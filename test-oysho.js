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

console.log('\n--- canlı sayfa (2026-10) ---');
const liveOysho = parseOyshoProduct(
  fs.readFileSync(path.join(__dirname, 'fixtures/oysho-live-2026-10.html'), 'utf8'),
  'https://www.oysho.com/tr/primaloft-dolgulu-yunlu-diplomatik-cizgili-ceket-l36495749?colorId=444&pelement=234993066&categoryId=1010328003'
);
check('canlı: productId', liveOysho.productId, '36495749');
check('canlı: isim', liveOysho.name, 'Primaloft® dolgulu yünlü diplomatik çizgili ceket');
check('canlı: renk', liveOysho.variants[0]?.color, 'Koyu okyanus mavisi');
check('canlı: fiyat', liveOysho.variants[0]?.price, 6590);
check('canlı: bedenler', liveOysho.variants.map((v) => v.size), ['XS', 'S', 'M', 'L', 'XL']);
check('canlı: stok', liveOysho.variants.map((v) => v.availability), ['in_stock', 'in_stock', 'in_stock', 'out_of_stock', 'out_of_stock']);

console.log('\n--- aynı ürün, iki renk: renk URL\'deki colorId ile belirlenir, yalnızca iletilen renk gelir ---');
// Oysho'da renk değişince sayfa adresindeki colorId değişiyor. Kullanıcı hangi renkli URL'yi iletirse YALNIZCA o renk
// takip edilir; kardeş renkler listelenmez (DOM'dan colorId'leri güvenilir çıkarılamıyor). Fixture'lar canlı sayfalar.
const { normalizeTrackingUrl } = require('./scraper/normalizeUrl');
const TERMAL = 'https://www.oysho.com/tr/termal-tshirt-base-layer-yar%C4%B1m-fermuarl%C4%B1-l30231895';
const termalUrl = (colorId) => `${TERMAL}?colorId=${colorId}&pelement=246216862&categoryId=1010832108`;
const termal = {};
for (const colorId of ['800', '959']) {
  termal[colorId] = parseOyshoProduct(
    fs.readFileSync(path.join(__dirname, `fixtures/oysho-termal-${colorId}-live-2026-10.html`), 'utf8'),
    termalUrl(colorId)
  );
}
check('800: renk adı sayfadaki seçili renkten', termal['800'].variants[0].color, 'SİYAH');
check('959: renk adı sayfadaki seçili renkten', termal['959'].variants[0].color, 'AÇIK EKRU');
check('800: yalnızca iletilen renk (kardeş renk yok)', termal['800'].relatedColors.map((c) => [c.name, c.colorId, c.selected]), [['SİYAH', '800', true]]);
check('959: yalnızca iletilen renk (kardeş renk yok)', termal['959'].relatedColors.map((c) => [c.name, c.colorId, c.selected]), [['AÇIK EKRU', '959', true]]);
check('SKU\'lar renkler arasında çakışmaz', termal['800'].variants.some((v) => termal['959'].variants.some((w) => w.sku === v.sku)), false);
check('SKU renk kimliğini URL\'den taşır', [termal['800'].variants[0].sku, termal['959'].variants[0].sku], ['30231895-800-XS', '30231895-959-XS']);
check('aynı ürün kimliği', [termal['800'].productId, termal['959'].productId], ['30231895', '30231895']);
check('bedenler ve fiyat', [termal['800'].variants.map((v) => v.size), termal['800'].variants[0].price], [['XS', 'S', 'M', 'L', 'XL'], 1790]);
check('kalıcı URL iletilen URL (renk korunur)', [termal['800'].canonicalUrl, termal['959'].canonicalUrl], [termalUrl('800'), termalUrl('959')]);
check('iki renk AYRI takip hedefi (dedup anahtarı colorId\'yi korur)', normalizeTrackingUrl(termalUrl('800')) === normalizeTrackingUrl(termalUrl('959')), false);
check('aynı renk, farklı takip parametreleri -> TEK hedef', normalizeTrackingUrl(termalUrl('800')) === normalizeTrackingUrl(`${TERMAL}?colorId=800&pelement=1&categoryId=2`), true);

console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
process.exit(ok ? 0 : 1);
