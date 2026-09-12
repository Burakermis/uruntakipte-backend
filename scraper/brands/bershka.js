const cheerio = require('cheerio');
const { parseTryPrice } = require('../priceUtils');

// Bershka (İnditex) Pull&Bear'e yakın bir Nuxt/Vue yapısı kullanıyor.
// Renkler Pull&Bear'deki gibi query param ile değişiyor (?colorId=<id>),
// ama Pull&Bear'in aksine renk seçici DOM'u aynı sayfada TÜM kardeş
// renklerin id + isim + url'ini listeliyor — bu yüzden H&M'deki gibi
// relatedColors çıkarabiliyoruz (Pull&Bear'de bunu yapamamıştık).
//
// Beden butonlarında (size-button) şu ana kadar paylaşılan örnekte hiçbir
// tükendi/az-kaldı sinyali yok (hepsi aria-pressed="false", sınıfsız) —
// bu yüzden şimdilik varsayılan in_stock, "disabled"/aria-disabled veya
// disabled/sold-out içeren sınıf adlarını tükendi için makul bir yedek
// sinyal olarak deniyoruz. Gerçek bir tükenmiş-beden örneği paylaşılırsa
// buraya eklenmeli.
function classifySizeAvailability($button) {
  const classes = ($button.attr('class') || '').split(/\s+/);
  const isDisabled =
    $button.attr('disabled') != null ||
    $button.attr('aria-disabled') === 'true' ||
    classes.some((c) => /disabled|sold-out|out-of-stock/.test(c));
  if (isDisabled) return 'out_of_stock';
  if (classes.some((c) => /low-stock|few-left|last-units/.test(c))) return 'low_stock';
  return 'in_stock';
}

function extractPrice($) {
  const text = $('[data-qa-anchor="productItemPrice"]').first().text().trim();
  return parseTryPrice(text);
}

function extractSizes($) {
  const sizes = [];
  $('.size-selector__list .size-button').each((_, el) => {
    const $el = $(el);
    const label = $el.find('.size-button__label').first().text().trim();
    if (label) {
      sizes.push({ size: label, availability: classifySizeAvailability($el) });
    }
  });
  return sizes;
}

// #color-selector__name içinde ekran-okuyucu için "Renk" etiketi de aynı
// span'in içinde duruyor; sadece doğrudan metin düğümlerini almak için alt
// elemanları klonlayıp çıkarıyoruz.
function extractColorName($) {
  const text = $('#color-selector__name').clone().children().remove().end().text().trim();
  return text || null;
}

function extractRelatedColors($, baseUrl) {
  const colors = [];
  $('[data-qa-anchor="productDetailColorList"] > li > a[role="option"]').each(
    (_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      const name = $el.attr('aria-label') || null;
      if (!href || !name) return;
      const liId = $el.closest('li').attr('id') || '';
      const colorIdMatch = href.match(/colorId=(\d+)/) || liId.match(/color-(\d+)/);
      let url = href;
      try {
        url = new URL(href, baseUrl).toString();
      } catch {
        /* baseUrl geçersizse href'i olduğu gibi bırak */
      }
      colors.push({
        name,
        colorId: colorIdMatch ? colorIdMatch[1] : null,
        url,
        selected: $el.attr('aria-selected') === 'true',
        swatchImage: $el.find('img').attr('src') || null,
      });
    }
  );
  return colors;
}

function extractProductIdFromUrl(url) {
  // "...-c0p227531249.html" — İnditex'in Bershka'daki ürün kodu deseni.
  const match = (url || '').match(/c0?p(\d+)/i);
  return match ? match[1] : null;
}

function extractMeta($, sourceUrl) {
  // og:title'ın kendisi de marka son eki taşıyabiliyor (yalnızca <title>
  // fallback'ini değil, og:title'ı da temizlemek gerekiyor). İlk "|"
  // karakterinden öncesini almak hepsinde işe yarıyor.
  const rawName = $('meta[property="og:title"]').attr('content') || $('title').first().text() || null;
  const name = rawName ? rawName.split('|')[0].trim() : null;
  const imageUrl = $('meta[property="og:image"]').attr('content') || null;
  const canonicalUrl = $('link[rel="canonical"]').attr('href') || sourceUrl;
  return { name, imageUrl, canonicalUrl };
}

/**
 * Bershka ürün sayfası HTML'inden fiyat/stok verisini çıkarır. Sayfa tek bir
 * rengin bedenlerini gösterir (URL'deki ?colorId= ile belirlenir); kardeş
 * renkler `relatedColors` alanında ayrı ayrı url+colorId olarak yer alır.
 */
function parseBershkaProduct(html, sourceUrl) {
  const $ = cheerio.load(html);
  const { price, currency } = extractPrice($);
  const sizeEntries = extractSizes($);
  const meta = extractMeta($, sourceUrl);
  const productId = extractProductIdFromUrl(meta.canonicalUrl || sourceUrl);
  const colorName = extractColorName($) || 'Tek Renk';
  const relatedColors = extractRelatedColors($, meta.canonicalUrl || sourceUrl);

  if (!productId && sizeEntries.length === 0 && price == null) {
    return null;
  }

  const variants = sizeEntries.map((entry, index) => ({
    sku: `${productId || 'bershka'}-${colorName}-${entry.size || index}`,
    color: colorName,
    size: entry.size,
    price,
    currency,
    availability: entry.availability,
    url: meta.canonicalUrl,
  }));

  return {
    productId: productId || meta.canonicalUrl,
    name: meta.name,
    brand: 'Bershka',
    imageUrl: meta.imageUrl,
    canonicalUrl: meta.canonicalUrl,
    checkedAt: new Date().toISOString(),
    variants,
    relatedColors,
  };
}

module.exports = {
  id: 'bershka',
  label: 'Bershka',
  hostnames: ['bershka.com'],
  parse: (html, url) => parseBershkaProduct(html, url),
  // ÖLÇÜM: Akamai interstitial'ı tarayıcı ~0,25sn'de çözüyor, beden listesi
  // ~0,7sn'de DOM'a geliyor — beklenecek tek şey o.
  fetchProfile: {
    ready: () => !!document.querySelector('.size-selector__list .size-button'),
  },
  // testler için:
  parseBershkaProduct,
  extractPrice,
  extractSizes,
  extractColorName,
  extractRelatedColors,
  classifySizeAvailability,
};
