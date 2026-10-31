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

console.log('\n--- canlı sayfa (2026-10): beden/stok sayfanın API yanıtından, HTML\'e gömülü ---');
// Pull&Bear bedenleri artık HTML'de listelemiyor; browserFetch sayfanın kendi API yanıtını yakalayıp
// <script id="__captured_api__"> olarak gömüyor. Bu fixture o gömülü hâli taşır; eski beden-listesi
// fixture'ı canlı sitenin ne yaptığını göstermediği için tek başına yetmiyordu.
const liveHtml = fs.readFileSync(path.join(__dirname, 'fixtures/pullandbear-api-live-2026-10.html'), 'utf8');
const BASE = 'https://www.pullandbear.com/tr/cift-kollu-tisort-l07230571';
const defaultColor = parsePullAndBearProduct(liveHtml, BASE);
check('canlı: en az 1 beden', defaultColor.variants.length > 0, true);
check('canlı: bedenler', defaultColor.variants.map((v) => v.size), ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL']);
check('canlı: varsayılan renk', defaultColor.variants[0].color, 'Siyah');
check('canlı: fiyat (kuruştan TL)', defaultColor.variants[0].price, 650);
check('canlı: Siyah tamamen tükenmiş', defaultColor.variants.every((v) => v.availability === 'out_of_stock'), true);
const green = parsePullAndBearProduct(liveHtml, BASE + '?colorId=500');
check('canlı: ?colorId=500 -> Yeşil', green.variants[0].color, 'Yeşil');
check('canlı: Yeşil farklı fiyatlı', green.variants[0].price, 1690);
check('canlı: Yeşil stokta', green.variants.every((v) => v.availability === 'in_stock'), true);
check('canlı: renk SKU\'ları ayrı', defaultColor.variants[0].sku === green.variants[0].sku, false);
check('canlı: bilinmeyen colorId -> varsayılan renk', parsePullAndBearProduct(liveHtml, BASE + '?colorId=999').variants[0].color, 'Siyah');

const { classifyApiSize, simplifyApiDetail, API_DETAIL_URL } = require('./scraper/brands/pullandbear');
check('SHOW -> in_stock', classifyApiSize({ visibility: 'SHOW', buyable: true }), 'in_stock');
check('SOLD_OUT -> out_of_stock (isBuyable true olsa bile)', classifyApiSize({ visibility: 'SOLD_OUT', buyable: true }), 'out_of_stock');
check('backSoon -> coming_soon', classifyApiSize({ visibility: 'SHOW', backSoon: true }), 'coming_soon');
check('bilinmeyen değer isBuyable\'a düşer', [classifyApiSize({ visibility: 'X', buyable: true }), classifyApiSize({ visibility: 'X', buyable: false })], ['in_stock', 'out_of_stock']);
check('API URL deseni', API_DETAIL_URL.test('https://www.pullandbear.com/itxrest/2/catalog/store/25009521/20309459/category/0/product/751232433/detail?languageId=-43'), true);
let threw = false;
try { simplifyApiDetail({ detail: {} }); } catch { threw = true; }
check('colors yoksa sadeleştirme hata verir (sessizce boş veri gömülmez)', threw, true);
check('gömülü veri yoksa eski DOM yoluna düşer', parsePullAndBearProduct(tshirtHtml, BASE).variants.length, 7);

console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
process.exit(ok ? 0 : 1);
