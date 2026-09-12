const fs = require('fs');
const path = require('path');
const { parsePullAndBearProduct, extractSizes } = require('./scraper/brands/pullandbear');
const cheerio = require('cheerio');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

console.log('--- gerçek sayfa (tişört, browserFetch ile canlı çekilmiş) ---');
const tshirtHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures/pullandbear-cift-kollu-tisort.html'),
  'utf8'
);
const tshirt = parsePullAndBearProduct(
  tshirtHtml,
  'https://www.pullandbear.com/tr/cift-kollu-tisort-l07230571'
);
check('productId', tshirt.productId, '07230571');
check('name', tshirt.name, 'Çift kollu tişört');
check('renk', tshirt.variants[0].color, 'Siyah');
check('fiyat', tshirt.variants[0].price, 1290);
check('beden sayısı', tshirt.variants.length, 7);
check('tüm bedenler stokta', tshirt.variants.every((v) => v.availability === 'in_stock'), true);

console.log('\n--- jean beden seçici (coming_soon durumu) ---');
const jeanHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures/pullandbear-jean-size-selector.html'),
  'utf8'
);
const $ = cheerio.load(jeanHtml);
const jeanSizes = extractSizes($);
check('beden sayısı', jeanSizes.length, 4);
check('34 -> coming_soon', jeanSizes[0].availability, 'coming_soon');
check('36 -> in_stock (is-selected stokla ilgisiz)', jeanSizes[1].availability, 'in_stock');
check('38 -> in_stock', jeanSizes[2].availability, 'in_stock');

console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
process.exit(ok ? 0 : 1);
