const cheerio = require('cheerio');
const { parseTryPrice } = require('../priceUtils');

// Stradivarius (İnditex), beden stok durumunu doğrudan class adlarıyla
// veriyor — Bershka/Mango gibi tahmine gerek kalmadan üç durumun üçü de
// GERÇEK bir örnekle doğrulandı:
//   "size-no-stock"    -> tükendi (ikon başlığı: "Benzer ürünleri görüntüle")
//   "size-last-units"  -> az kaldı (ikon başlığı: "Son ürünler")
//   (sınıfsız/varsayılan) -> stokta
// Ayrıca her beden butonunun kendi <p data-sku="..."> alanı var — Massimo
// Dutti'deki gibi sitenin kendi verdiği stabil bir sku, kendimiz üretmemize
// gerek yok.
function classifySizeAvailability($button) {
  const classes = ($button.attr('class') || '').split(/\s+/);
  if (classes.includes('size-no-stock')) return 'out_of_stock';
  if (classes.includes('size-last-units')) return 'low_stock';
  return 'in_stock';
}

// Fiyat İKİ farklı biçimde geliyor — CANLI doğrulandı: indirimliyse
// `.discount .STRPrice` (kırmızı, güncel fiyat) + ayrı bir `.discount-price`
// (gri, üstü çizili eski fiyat) `#discount` sarmalayıcısı içinde; indirim
// YOKSA `#discount` elementi DOM'da hiç yok, tek başına bir
// `.STRPrice.STRPrice_black` span'i kalıyor (ilk varsayımımız #discount'a
// bağımlıydı, bu yüzden indirimsiz üründe boş dönüyordu — canlı testte
// yakalandı). Bu yüzden aramayı tüm belgede yapıyoruz, #discount'a bağımlı
// kalmıyoruz.
function extractPrice($) {
  const discounted = $('.discount .STRPrice').first();
  const text = discounted.length
    ? discounted.text().trim()
    : $('.STRPrice').not('.discount-price').first().text().trim();
  return parseTryPrice(text);
}

function extractSizes($) {
  const sizes = [];
  $('[data-testid="sizes-list"] button[data-testid="size-item"]').each((_, el) => {
    const $el = $(el);
    const $label = $el.find('p[data-testid="size-name"]').first();
    const label = $label.attr('data-text') || $label.text().trim();
    const sku = $label.attr('data-sku') || null;
    if (label) {
      sizes.push({ size: label, sku, availability: classifySizeAvailability($el) });
    }
  });
  return sizes;
}

// Renk butonlarının <a href> YOK (Massimo Dutti'deki gibi JS-tetiklemeli) —
// bu yüzden colorId'yi görsel dosya adından çıkarıyoruz
// (".../01214154042-m/...jpg" -> productId "01214154" + colorId "042").
// NOT: aynı liste elemanlarındaki data-ref özniteliği ("C...-V2026") tutarsız
// uzunlukta geldi (üçüncü örnekte fazladan haneler vardı) — güvenilir
// bulunmadığı için KULLANILMADI, görsel dosya adı tercih edildi.
function extractColorIdFromSrc(src) {
  const match = (src || '').match(/(\d{11})-m\b/);
  return match ? match[1].slice(-3) : null;
}

function extractRelatedColors($, sourceUrl) {
  const colors = [];
  const baseUrlNoQuery = (sourceUrl || '').split('?')[0];
  $('[data-testid="colors-list"] > li.color-item').each((_, li) => {
    const $li = $(li);
    const img = $li.find('img').first();
    const name = (img.attr('alt') || '').trim();
    const src = img.attr('src') || '';
    const colorId = extractColorIdFromSrc(src);
    if (!name || !colorId) return;
    const selected = $li.find('.color-selected').length > 0;
    colors.push({
      name,
      colorId,
      url: `${baseUrlNoQuery}?colorId=${colorId}`,
      selected,
      swatchImage: src || null,
    });
  });
  return colors;
}

function extractProductIdFromUrl(url) {
  // "...-l01214154" — İnditex'in Pull&Bear/Massimo Dutti ile paylaştığı
  // ürün-satır kodu deseni.
  const match = (url || '').split('?')[0].match(/-l(\d+)$/i);
  return match ? match[1] : null;
}

function extractMeta($) {
  // og:title'ın kendisi de marka son eki taşıyabiliyor (yalnızca <title>
  // fallback'ini değil, og:title'ı da temizlemek gerekiyor). İlk "|"
  // karakterinden öncesini almak hepsinde işe yarıyor.
  const rawName = $('meta[property="og:title"]').attr('content') || $('title').first().text() || null;
  const name = rawName ? rawName.split('|')[0].trim() : null;
  const imageUrl = $('meta[property="og:image"]').attr('content') || null;
  return { name, imageUrl };
}

/**
 * Stradivarius ürün sayfası HTML'inden fiyat/stok verisini çıkarır. Sayfa
 * tek bir rengin bedenlerini gösterir; kardeş renkler `relatedColors`
 * alanında (kendi kurduğumuz ?colorId= URL'leriyle) yer alır.
 */
function parseStradivariusProduct(html, sourceUrl) {
  const $ = cheerio.load(html);
  const { price, currency } = extractPrice($);
  const sizeEntries = extractSizes($);
  const productId = extractProductIdFromUrl(sourceUrl);
  const meta = extractMeta($);
  const relatedColors = extractRelatedColors($, sourceUrl);
  const activeColor = relatedColors.find((c) => c.selected);
  const colorId = activeColor ? activeColor.colorId : null;
  const colorName = activeColor ? activeColor.name : 'Tek Renk';

  if (!productId && sizeEntries.length === 0 && price == null) {
    return null;
  }

  const variants = sizeEntries.map((entry, index) => ({
    sku: entry.sku || `${productId || 'stradivarius'}-${colorId || colorName}-${entry.size || index}`,
    color: colorName,
    size: entry.size,
    price,
    currency,
    availability: entry.availability,
    url: sourceUrl,
  }));

  return {
    productId: productId || sourceUrl,
    name: meta.name,
    brand: 'Stradivarius',
    imageUrl: meta.imageUrl,
    canonicalUrl: sourceUrl,
    checkedAt: new Date().toISOString(),
    variants,
    relatedColors,
  };
}

module.exports = {
  id: 'stradivarius',
  label: 'Stradivarius',
  hostnames: ['stradivarius.com'],
  parse: (html, url) => parseStradivariusProduct(html, url),
  // ÖLÇÜM: 8 marka içinde en yavaşı — beden/stok verisi
  // /itxrest/.../product/<id>/detail çağrısıyla ~3,4sn'de geliyor, Angular
  // onu ~5sn'de DOM'a basıyor. Bekleme DOM'a bağlı olduğu sürece bu 5sn'nin
  // altına inemiyoruz; asıl çözüm o JSON'u doğrudan okumak (bkz. README
  // niteliğindeki not: parser DOM yerine itxrest yanıtını okursa ~3,4sn'e,
  // API'ye doğrudan gidilirse ~0,5sn'e iner).
  fetchProfile: {
    ready: () => !!document.querySelector('[data-testid="sizes-list"] button[data-testid="size-item"]'),
  },
  // testler için:
  parseStradivariusProduct,
  extractPrice,
  extractSizes,
  extractRelatedColors,
  extractColorIdFromSrc,
  classifySizeAvailability,
  extractProductIdFromUrl,
};
