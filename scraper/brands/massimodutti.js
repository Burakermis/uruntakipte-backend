const cheerio = require('cheerio');

// Massimo Dutti (İnditex), Angular Universal SSR kullanıyor. Önce DOM'dan
// (fiyat aria-label'ı + renk/beden buton class'ları) parse etmeyi denedik,
// ama CANLI tarayıcı testinde kritik bir şey keşfedildi: beden/stok verisini
// taşıyan `<product-size-selector-layout>` bileşeni, "Sepete ekle"ye
// tıklandıktan ve saniyelerce beklendikten SONRA BİLE DOM'a hiç gelmiyor —
// Angular'ın `pdp-customize-button` component'i boş kalıyor (headless ortam,
// A/B testi ya da stok mikroservisi engeli olabilir, kesin sebep belirsiz).
//
// Bunun yerine Angular Universal'ın SSR "TransferState" mekanizmasıyla HER
// SAYFADA gömülü gelen `<script id="mdfrontw-state" type="application/json">`
// bloğunu okuyoruz — DOM hiç render etmese de sunucunun tam hesapladığı ham
// veri burada: `ITX_GET_PRODUCT_DETAIL_KEY.colors[].sizes[]` altında TÜM
// renklerin TÜM bedenleri, fiyatları ve gerçek stok bayraklarıyla
// (isBuyable/backSoon) birlikte geliyor. Bu hem DOM class'larından çok daha
// stabil (Angular'ın kendi state anahtarı) hem de TEK istekte TÜM renk×beden
// kombinasyonlarını veriyor — Bershka/H&M/Mango'daki gibi renk başına ayrı
// sayfa/parametre çekmeye gerek yok (Zara'nın tek-sayfa-tüm-renkler modeliyle
// aynı avantaj).
function extractTransferState($) {
  const raw = $('#mdfrontw-state').first().html();
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data.ITX_GET_PRODUCT_DETAIL_KEY || null;
  } catch {
    return null;
  }
}

// "isBuyable" doğrudan satın-alınabilirlik sinyali; "backSoon" ("1"/"0")
// "yakında" durumunu ayırt ediyor. Az-kaldı (low_stock) için ayrı bir miktar
// alanı görülmedi — bu API'de o bilgi yok gibi görünüyor, bu yüzden diğer
// markalardaki gibi tahmini bir class-adı kontrolü UYDURMUYORUZ; veri yoksa
// low_stock hiç dönmez (in_stock/out_of_stock/coming_soon ile sınırlı,
// gerçek veriye dayalı üçü de doğrulandı).
function classifySizeAvailability(size) {
  if (size.backSoon === '1' || size.backSoon === 1) return 'coming_soon';
  if (size.isBuyable === false) return 'out_of_stock';
  return 'in_stock';
}

function extractMainImage(color) {
  const medias = Array.isArray(color?.medias) ? color.medias : [];
  const main = medias.find((m) => m.clazz && m.clazz.type === 'main');
  return (main || medias[0] || {}).path || null;
}

function extractProductIdFromUrl(url) {
  // "...-l00778176" — İnditex'in Pull&Bear/Massimo Dutti'de ortak kullandığı
  // ürün-satır kodu deseni.
  const match = (url || '').split('?')[0].match(/-l(\d+)$/i);
  return match ? match[1] : null;
}

/**
 * Massimo Dutti ürün sayfası HTML'inden fiyat/stok verisini çıkarır.
 * Zara'daki gibi TEK sayfa TÜM renklerin bedenlerini içeriyor — variants
 * listesi bu yüzden tüm renk×beden kombinasyonlarını kapsar, ayrı bir
 * relatedColors alanına gerek kalmıyor (registry.js'deki groupVariantsByColor
 * zaten bunları renk bazında gruplar).
 */
function parseMassimoDuttiProduct(html, sourceUrl) {
  const $ = cheerio.load(html);
  const detail = extractTransferState($);
  if (!detail || !Array.isArray(detail.colors) || detail.colors.length === 0) {
    return null;
  }

  const baseUrlNoQuery = (sourceUrl || '').split('?')[0];
  const productId = extractProductIdFromUrl(sourceUrl) || String(detail.id);
  const name = detail.name || null;

  const variants = [];
  for (const color of detail.colors) {
    const sizes = Array.isArray(color.sizes) ? color.sizes : [];
    for (const size of sizes) {
      // Fiyat kuruş cinsinden geliyor (300000 = 3.000,00 TL).
      const priceMinor = Number(size.price ?? detail.priceInfo?.price);
      variants.push({
        sku: String(size.sku),
        color: color.name,
        size: size.name,
        price: Number.isFinite(priceMinor) ? priceMinor / 100 : null,
        // Bu API'de para birimi kodu ayrı bir alanda gelmiyor
        // (priceWithCurrencySymbol boş string); sadece TR mağazasını
        // desteklediğimiz için TRY sabitlendi.
        currency: 'TRY',
        availability: classifySizeAvailability(size),
        url: `${baseUrlNoQuery}?colorId=${color.id}`,
      });
    }
  }

  if (variants.length === 0) return null;

  const mainColor = detail.colors.find((c) => c.id === detail.mainColorid) || detail.colors[0];

  return {
    productId,
    name,
    brand: 'Massimo Dutti',
    imageUrl: extractMainImage(mainColor),
    canonicalUrl: baseUrlNoQuery,
    checkedAt: new Date().toISOString(),
    variants,
  };
}

module.exports = {
  id: 'massimodutti',
  label: 'Massimo Dutti',
  hostnames: ['massimodutti.com'],
  parse: (html, url) => parseMassimoDuttiProduct(html, url),
  // Parser DOM'u değil SSR TransferState script'ini okuyor — o da ilk HTML ile
  // birlikte geliyor, yani beklenecek tek şey script'in varlığı (~0,6sn).
  // NOT: script'in VARLIĞINA bakmak yetmiyor — sayfa akış hâlinde (streaming)
  // geldiği için element DOM'a yarım JSON'la da düşebiliyor (canlı testte
  // bir kez PARSE_FAILED'a yol açtı). Bu yüzden koşul, parser'ın okuduğu
  // anahtarın gerçekten ayrıştırılabilir olmasını arıyor.
  fetchProfile: {
    ready: () => {
      const el = document.querySelector('#mdfrontw-state');
      if (!el) return false;
      try {
        return !!JSON.parse(el.textContent).ITX_GET_PRODUCT_DETAIL_KEY;
      } catch {
        return false;
      }
    },
  },
  // testler için:
  parseMassimoDuttiProduct,
  extractTransferState,
  classifySizeAvailability,
  extractMainImage,
  extractProductIdFromUrl,
};
