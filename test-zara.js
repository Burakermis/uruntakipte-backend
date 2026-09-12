const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { parseZaraProduct, extractDomSizeStock } = require('./scraper/brands/zara');

const html = fs.readFileSync(path.join(__dirname, 'fixtures/zara-aaron-levine-tshirt.html'), 'utf8');
const result = parseZaraProduct(html);

console.log('--- parseZaraProduct sonucu ---');
console.log(JSON.stringify(result, null, 2));

console.log('\n--- doğrulama ---');
const expectedAvailability = {
  'Ekru|S (US S)': 'in_stock',
  'Ekru|M (US M)': 'in_stock',
  'Ekru|L (US L)': 'in_stock',
  'Ekru|XL (US XL)': 'coming_soon', // DOM: size-back-soon -> viewPayload/JSON-LD OutOfStock'u ezmeli
  'Siyah|S (US S)': 'in_stock',      // viewPayload'dan (renk seçili değil, DOM yok)
  'Siyah|M (US M)': 'low_stock',     // viewPayload'dan (JSON-LD sadece LimitedAvailability derdi)
  'Siyah|L (US L)': 'in_stock',
  'Siyah|XL (US XL)': 'coming_soon', // viewPayload'dan (JSON-LD sadece OutOfStock derdi)
};

let ok = true;
for (const v of result.variants) {
  const key = `${v.color}|${v.size}`;
  const expected = expectedAvailability[key];
  const pass = v.availability === expected;
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${key.padEnd(16)} -> ${v.availability} (source: ${v.availabilitySource}, beklenen: ${expected})`);
}

// Kullanıcının paylaştığı ikinci örnek beden-seçici bloğu (low-on-stock + out-of-stock durumları)
// bağımsız olarak DOM_ACTION_MAP eşlemesini doğrular.
console.log('\n--- ikinci örnek (low-on-stock / out-of-stock) DOM eşleme testi ---');
const secondSnippet = `<ul class="size-selector-sizes"><li class="size-selector-sizes__size size-selector-sizes-size size-selector-sizes-size--enabled"><button class="size-selector-sizes-size__button" data-qa-action="size-low-on-stock"><div class="size-selector-sizes-size__label size-selector-sizes-size__element" data-qa-qualifier="size-selector-sizes-size-label">S (US S)</div><div class="size-selector-sizes-size__action size-selector-sizes-size__element"><span>Az sayıda ürün</span></div></button></li><li class="size-selector-sizes__size size-selector-sizes-size size-selector-sizes-size--enabled"><button class="size-selector-sizes-size__button" data-qa-action="size-low-on-stock"><div class="size-selector-sizes-size__label size-selector-sizes-size__element" data-qa-qualifier="size-selector-sizes-size-label">M (US M)</div><div class="size-selector-sizes-size__action size-selector-sizes-size__element"><span>Az sayıda ürün</span></div></button></li><li class="size-selector-sizes__size size-selector-sizes__size--disabled size-selector-sizes-size size-selector-sizes-size--unavailable size-selector-sizes-size--enabled"><button class="size-selector-sizes-size__button" data-qa-action="size-out-of-stock"><div class="size-selector-sizes-size__label size-selector-sizes-size__element" data-qa-qualifier="size-selector-sizes-size-label">L (US L)</div><div class="size-selector-sizes-size__action size-selector-sizes-size__element"><span>Benzer ürünler</span></div></button></li><li class="size-selector-sizes__size size-selector-sizes__size--disabled size-selector-sizes-size size-selector-sizes-size--unavailable size-selector-sizes-size--enabled"><button class="size-selector-sizes-size__button" data-qa-action="size-out-of-stock"><div class="size-selector-sizes-size__label size-selector-sizes-size__element" data-qa-qualifier="size-selector-sizes-size-label">XL (US XL)</div><div class="size-selector-sizes-size__action size-selector-sizes-size__element"><span>Benzer ürünler</span></div></button></li></ul>`;
const $2 = cheerio.load(secondSnippet);
const stock2 = extractDomSizeStock($2);
const expected2 = {
  'S (US S)': 'low_stock',
  'M (US M)': 'low_stock',
  'L (US L)': 'out_of_stock',
  'XL (US XL)': 'out_of_stock',
};
for (const [size, expectedState] of Object.entries(expected2)) {
  const got = stock2.get(size);
  const pass = got === expectedState;
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${size.padEnd(10)} -> ${got} (beklenen: ${expectedState})`);
}

console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
process.exit(ok ? 0 : 1);
