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

// Pull&Bear (2026-10) bedenleri artık sayfada listelemiyor; stok/fiyat sayfanın kendi çağrısı olan
// itxrest .../product/<id>/detail yanıtında geliyor (düz fetch 403). browserFetch bu yanıtı
// captureResponse ile yakalayıp aşağıdaki sade biçimde HTML'e gömüyor (id="__captured_api__").
const API_DETAIL_URL = /\/itxrest\/\d+\/catalog\/store\/\d+\/\d+\/category\/\d+\/product\/\d+\/detail/;

function simplifyApiDetail(json) {
  const colors = json?.detail?.colors;
  if (!Array.isArray(colors) || colors.length === 0) throw new Error('detail.colors yok');
  return {
    mainColorId: json.mainColorid != null ? String(json.mainColorid) : null,
    colors: colors.map((c) => ({
      id: String(c.id),
      name: c.name,
      sizes: (c.sizes || []).map((s) => ({
        name: s.name,
        visibility: s.visibilityValue,
        buyable: s.isBuyable,
        backSoon: s.backSoon && s.backSoon !== '0' ? true : false,
        price: s.price, // kuruş: "65000" = 650,00 TL
      })),
    })),
  };
}

// visibilityValue: gözlenen "SHOW" (satışta) ve "SOLD_OUT". Diğer değerler henüz görülmedi; adlarına göre
// makul bir tahmin yapılıyor, bilinmeyen değerde isBuyable'a bakılıyor.
function classifyApiSize(size) {
  const v = String(size.visibility || '').toUpperCase();
  if (v === 'SOLD_OUT' || v === 'HIDE' || v === 'HIDDEN') return 'out_of_stock';
  if (size.backSoon || /BACK_?SOON|COMING/.test(v)) return 'coming_soon';
  if (/LOW|LAST|FEW/.test(v)) return 'low_stock';
  if (v === 'SHOW') return 'in_stock';
  return size.buyable ? 'in_stock' : 'out_of_stock';
}

function extractApiData($) {
  const raw = $('script#__captured_api__').contents().text();
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data.colors) && data.colors.length > 0 ? data : null;
  } catch {
    return null;
  }
}

// Hangi renk? Öncelik: URL'deki colorId, sonra JSON-LD rengi, sonra sitenin ana rengi, sonra ilk renk.
function pickApiColor(data, sourceUrl, ldColorName) {
  let urlColorId = null;
  try {
    urlColorId = new URL(sourceUrl).searchParams.get('colorId');
  } catch {
    /* geçersiz url */
  }
  return (
    (urlColorId && data.colors.find((c) => c.id === urlColorId)) ||
    (ldColorName && data.colors.find((c) => c.name === ldColorName)) ||
    data.colors.find((c) => c.id === data.mainColorId) ||
    data.colors[0]
  );
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
  const apiData = extractApiData($);
  const apiColor = apiData ? pickApiColor(apiData, sourceUrl, jsonLd?.offers?.color) : null;
  const sizeEntries = apiColor
    ? apiColor.sizes.map((s) => ({ size: s.name, availability: classifyApiSize(s), apiPrice: Number(s.price) / 100 }))
    : extractSizes($);
  const canonicalUrl = extractCanonicalUrl($, sourceUrl);
  const productId = extractProductIdFromUrl(canonicalUrl);

  const price = domPrice ?? (jsonLd?.offers?.price != null ? Number(jsonLd.offers.price) : null);
  const currency = domCurrency ?? jsonLd?.offers?.priceCurrency ?? null;
  const colorName = apiColor?.name || jsonLd?.offers?.color || 'Tek Renk';
  const name = jsonLd?.name || null;
  const imageUrl = jsonLd?.image || null;

  if (!productId && sizeEntries.length === 0 && price == null) {
    return null;
  }

  const variants = sizeEntries.map((entry, index) => ({
    sku: `${productId || 'pb'}-${colorName}-${entry.size || index}`,
    color: colorName,
    size: entry.size,
    // Renk başına fiyat API'den (renkler farklı fiyatlı olabiliyor: 650 TL / 1.690 TL), yoksa sayfa fiyatı.
    price: Number.isFinite(entry.apiPrice) && entry.apiPrice > 0 ? entry.apiPrice : price,
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
  // Stok/beden verisi sayfanın kendi API yanıtından yakalanıyor (bkz. captureResponse, yukarıdaki
  // açıklama); browserFetch yanıtı en fazla 8 sn bekler. Hazır-olma koşulu yalnızca sayfanın JSON-LD
  // bloğu: eski beden listesini (shadow DOM'da) beklemek artık 12 sn boşa bekleme demekti.
  fetchProfile: {
    captureResponse: { match: API_DETAIL_URL, transform: simplifyApiDetail },
    ready: () => !!document.querySelector('script[type="application/ld+json"]'),
  },
  // testler için:
  parsePullAndBearProduct,
  extractPrice,
  extractSizes,
  classifyAvailability,
  classifyApiSize,
  simplifyApiDetail,
  API_DETAIL_URL,
};
