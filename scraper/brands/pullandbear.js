const cheerio = require('cheerio');
const { parseTryPrice } = require('../priceUtils');

// Pull&Bear (İnditex ailesinden) fiyat/beden bilgisini <price-element> ve
// <size-selector-with-length> gibi Web Component'lerin Shadow DOM'unda
// tutuyor. browserFetch.js bu Shadow DOM'u sayfayı almadan önce "düzleştirip"
// normal HTML'e gömüyor (bkz. browserFetch.js) — bu parser'ın gördüğü HTML
// zaten düzleştirilmiş hâldedir, düz bir fetch()'in ham yanıtında bu
// elementler BOŞ görünür.
//
// Beden butonlarındaki sınıf değiştiricileri (yalnızca gözlemlediklerimiz):
//   "is-back-soon"  -> ürün henüz satışta değil ("Bana haber ver!" metniyle)
//   "is-selected"   -> o an seçili beden (stokla ilgisi yok)
// Tükendi/az-kaldı durumları için henüz gerçek bir örnek görmedik — button'un
// "disabled" özniteliğini tükendi için makul bir yedek sinyal olarak
// kullanıyoruz. Gerçek bir tükenmiş-beden örneği paylaşılırsa buraya
// eklenmeli.
function classifyAvailability($button) {
  const classes = ($button.attr('class') || '').split(/\s+/);
  const hasComingSoonSpan = $button.find('.coming-soon').length > 0;
  if (classes.includes('is-back-soon') || hasComingSoonSpan) return 'coming_soon';
  if ($button.attr('disabled') != null || classes.some((c) => /sold-out|out-of-stock|disabled/.test(c))) {
    return 'out_of_stock';
  }
  if (classes.some((c) => /low-stock|few-left|last-units/.test(c))) return 'low_stock';
  return 'in_stock';
}

function extractPrice($) {
  const text = $('price-element .price').first().text().trim();
  return parseTryPrice(text);
}

function extractSizes($) {
  const sizes = [];
  $('size-selector-with-length .size-list button[role="option"]').each((_, el) => {
    const $el = $(el);
    const label = $el.find('.name').first().text().trim();
    if (label) {
      sizes.push({ size: label, availability: classifyAvailability($el) });
    }
  });
  return sizes;
}

function extractJsonLd($) {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const json = JSON.parse($(el).contents().text());
      if (json['@type'] === 'Product') return json;
    } catch {
      /* bu script bloğu JSON değil/Product değil, sıradakine geç */
    }
  }
  return null;
}

function extractCanonicalUrl($, sourceUrl) {
  return $('link[rel="canonical"]').attr('href') || sourceUrl;
}

function extractProductIdFromUrl(url) {
  // "...-l07230571" gibi bir sonek — İnditex'in ürün-satır kodu.
  const match = (url || '').match(/-l(\d+)(?:$|[?#])/);
  return match ? match[1] : null;
}

/**
 * Pull&Bear ürün sayfası HTML'inden (Shadow DOM'u düzleştirilmiş hâliyle)
 * fiyat/stok verisini çıkarır. Renkler H&M gibi ayrı URL/query-param
 * (?cS=<kod>) ile değişiyor — bu adapter sadece verilen URL'in gösterdiği
 * TEK rengin bedenlerini döner, kardeş renkleri keşfetmiyor (henüz bir renk
 * seçici DOM'u görmedik).
 */
function parsePullAndBearProduct(html, sourceUrl) {
  const $ = cheerio.load(html);
  const jsonLd = extractJsonLd($);
  const { price: domPrice, currency: domCurrency } = extractPrice($);
  const sizeEntries = extractSizes($);
  const canonicalUrl = extractCanonicalUrl($, sourceUrl);
  const productId = extractProductIdFromUrl(canonicalUrl);

  const price = domPrice ?? (jsonLd?.offers?.price != null ? Number(jsonLd.offers.price) : null);
  const currency = domCurrency ?? jsonLd?.offers?.priceCurrency ?? null;
  const colorName = jsonLd?.offers?.color || 'Tek Renk';
  const name = jsonLd?.name || null;
  const imageUrl = jsonLd?.image || null;

  if (!productId && sizeEntries.length === 0 && price == null) {
    return null;
  }

  const variants = sizeEntries.map((entry, index) => ({
    sku: `${productId || 'pb'}-${colorName}-${entry.size || index}`,
    color: colorName,
    size: entry.size,
    price,
    currency,
    availability: entry.availability,
    url: canonicalUrl,
  }));

  return {
    productId: productId || canonicalUrl,
    name,
    brand: 'Pull&Bear',
    imageUrl,
    canonicalUrl,
    checkedAt: new Date().toISOString(),
    variants,
  };
}

module.exports = {
  id: 'pullandbear',
  label: 'Pull&Bear',
  hostnames: ['pullandbear.com'],
  parse: (html, url) => parsePullAndBearProduct(html, url),
  // Beden seçici İÇ İÇE shadow root'ların altında duruyor: düz bir
  // document.querySelector('size-selector-with-length') ONU HİÇ GÖREMEZ
  // (canlı testte 15sn boyunca "yok" göründü, oysa düzleştirilmiş HTML'de
  // bedenler vardı). Bu yüzden hazır-olma koşulu shadow root'lara İNEN bir
  // arama yapıyor — ~2,8sn'de geliyor. NOT: sayfanın CSP'si eval'i
  // engelliyor, koşul kendi kendine yeten (closure'suz, eval'siz) olmalı.
  fetchProfile: {
    flattenShadowDom: true,
    ready: () => {
      const seen = new Set();
      function walk(root) {
        if (!root || seen.has(root)) return false;
        seen.add(root);
        if (root.querySelector('.size-list button[role="option"]')) return true;
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot && walk(el.shadowRoot)) return true;
        }
        return false;
      }
      return walk(document);
    },
  },
  // testler için:
  parsePullAndBearProduct,
  extractPrice,
  extractSizes,
  classifyAvailability,
};
