const zara = require('./brands/zara');
const hm = require('./brands/hm');
const pullandbear = require('./brands/pullandbear');
const bershka = require('./brands/bershka');
const mango = require('./brands/mango');
const massimodutti = require('./brands/massimodutti');
const stradivarius = require('./brands/stradivarius');
const oysho = require('./brands/oysho');

// Yeni bir marka eklemek için: brands/<marka>.js dosyasını
// { id, label, hostnames, parse(html, url) } şeklini dolduracak şekilde
// yaz, aşağıdaki listeye ekle. Başka hiçbir yeri değiştirmen gerekmez.
const BRANDS = [zara, hm, pullandbear, bershka, mango, massimodutti, stradivarius, oysho];

function normalizeHostname(hostname) {
  return hostname.replace(/^www\./, '').toLowerCase();
}

/**
 * Verilen URL'in hangi markaya ait olduğunu bulur.
 * @param {string} url
 * @returns {object|null} eşleşen brand adapter, yoksa null
 */
function detectBrand(url) {
  let hostname;
  try {
    const parsed = new URL(url);
    // Yalnızca http(s). Şema doğrulanmıyordu: "file://www.zara.com/...",
    // "javascript://www.zara.com/%0A..." gibi adresler marka alan adını taşıyıp
    // tarayıcıya kadar ulaşıyordu (canlı testte file:// bir Windows SMB/UNC
    // denemesine dönüşüp 22sn'lik bir Chromium slotu tuttu).
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    hostname = normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
  return (
    BRANDS.find((brand) =>
      brand.hostnames.some((h) => hostname === h || hostname.endsWith(`.${h}`))
    ) || null
  );
}

function isSupportedUrl(url) {
  return detectBrand(url) !== null;
}

// Markalar renk adını sitede tutarsız yazıyor (ör. Zara bazı gruplanmış
// renkleri "çeşitli" gibi küçük harfle döndürüyor, "Beyaz"/"Siyah" gibi
// düzgün büyük harfli olanların yanında tuhaf duruyor). Tüm markalarda
// tutarlı olsun diye ilk harf burada, tek yerde büyütülüyor. Standart
// toUpperCase() Türkçe'ye özgü değil (küçük "i" → yanlış "I"), bu yüzden
// ilk harf "i" ise elle "İ"ye çevriliyor.
function capitalizeColorName(color) {
  if (!color) return color;
  const first = color.charAt(0);
  const upperFirst = first.toLowerCase() === 'i' ? 'İ' : first.toUpperCase();
  return upperFirst + color.slice(1);
}

function normalizeVariantColors(variants) {
  return variants.map((v) => ({ ...v, color: capitalizeColorName(v.color) }));
}

// Her markanın "sayfayı nasıl çekmeli" profili (bkz. brands/*.js
// fetchProfile). browserFetch.js sabit bir süre beklemek yerine markanın
// `ready` koşulunu yokluyor, fetchHtml.js de düz fetch'in o markada işe
// yarayıp yaramadığını buradan öğreniyor. Profili olmayan/bilinmeyen marka
// için güvenli varsayılan: düz fetch dene, hazır-olma koşulu yok.
const DEFAULT_FETCH_PROFILE = {
  plainFetchWorks: false,
  flattenShadowDom: false,
  // true: stealth'siz, pencereli, otomasyon bayrakları kapalı ayrı bir
  // tarayıcı kullan (bkz. browserFetch.js launchBrowser) — Akamai'nin
  // headless/stealth'i tanıdığı markalar için (H&M).
  headed: false,
  // Küçük (engel gibi görünen) bir belge bu süreden sonra hâlâ sürüyorsa
  // beklemeyi kes (bkz. browserFetch.js BLOCK_GRACE_MS). null: varsayılan.
  blockGraceMs: null,
  ready: null,
};

function brandFetchProfile(brandId) {
  const brand = BRANDS.find((b) => b.id === brandId);
  return { ...DEFAULT_FETCH_PROFILE, ...(brand?.fetchProfile || {}) };
}

// Flat variant listesini "Renk Seçin" -> "Beden Seçin" UI akışı için
// renk bazında gruplar. Bu, marka adapter'larının hepsinde tekrarlanmasın
// diye burada, tek yerde yapılıyor.
function groupVariantsByColor(variants) {
  const byColor = new Map();
  for (const v of variants) {
    if (!byColor.has(v.color)) {
      byColor.set(v.color, { name: v.color, sizes: [] });
    }
    byColor.get(v.color).sizes.push({
      size: v.size,
      sku: v.sku,
      price: v.price,
      currency: v.currency,
      availability: v.availability,
    });
  }
  return Array.from(byColor.values());
}

/**
 * Bir markanın HTML'ini parse edip normalize edilmiş ürün + renk/beden
 * gruplaması döner. Desteklenmeyen URL için { error: 'UNSUPPORTED_SITE' }.
 * @param {{ url: string, html: string }} params
 */
function resolveProductFromHtml({ url, html }) {
  const brand = detectBrand(url);
  if (!brand) {
    return { error: 'UNSUPPORTED_SITE', message: `${url} adresi şu an desteklenmiyor.` };
  }

  const parsed = brand.parse(html, url);
  if (!parsed) {
    return { error: 'PARSE_FAILED', message: 'Ürün verisi sayfadan okunamadı.' };
  }

  const variants = normalizeVariantColors(parsed.variants);

  // Tek bir varyant bile çıkmadıysa bu bir "başarılı parse" değil. Bershka/
  // Pull&Bear/Stradivarius/Oysho adapter'ları productId'yi URL'den türettiği
  // için, bot-engeli sayfasında bile parse "başarılı ama 0 beden" dönebiliyor
  // (engel sayfası 5000 baytı geçerse fetchHtml'in uzunluk kontrolü de
  // yakalayamaz). Böyle bir sonucu kaydetmek, kullanıcıya bedensiz bir ürün
  // ve ardından yanlış stok bildirimleri olarak geri döner — takip edilecek
  // hiçbir şey yoksa açıkça hata vermek doğrusu.
  if (variants.length === 0) {
    return { error: 'PARSE_FAILED', message: 'Ürün verisi sayfadan okunamadı.' };
  }

  return {
    brand: brand.id,
    brandLabel: brand.label,
    productId: parsed.productId,
    name: parsed.name,
    imageUrl: parsed.imageUrl || null,
    canonicalUrl: parsed.canonicalUrl,
    checkedAt: parsed.checkedAt,
    variants,
    colors: groupVariantsByColor(variants),
    // H&M gibi renk-başına-ayrı-sayfa modeli kullanan markalarda kardeş
    // renklerin URL'leri (bkz. brands/hm.js). Bu modeli kullanmayan
    // markalarda (Zara) undefined kalır.
    relatedColors: parsed.relatedColors,
  };
}

module.exports = { BRANDS, detectBrand, isSupportedUrl, groupVariantsByColor, resolveProductFromHtml, brandFetchProfile };
