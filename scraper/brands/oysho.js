const cheerio = require('cheerio');
const { parseTryPrice } = require('../priceUtils');

// Oysho (İnditex) Angular tabanlı, custom element'lerle (oy-product-price-item,
// oy-product-size-selector) render ediyor. Fiyat için data-testid çok temiz:
// indirimliyse "product-price-sale" GÜNCEL fiyatı, "product-price-old" ÜSTÜ
// ÇİZİLİ eski fiyatı taşıyor; indirimsiz bir örnek görmedik ama muhtemelen
// tek bir data-testid="product-price-item-price" kalır diye üçüncü kademe
// bir yedek eklendi (doğrulanmamış varsayım — Stradivarius'ta indirimsiz
// örnekte kök elementin TAMAMEN yok olduğunu gördük, burada da benzer bir
// sürpriz olabilir).
function extractPrice($) {
  const sale = $('[data-testid="product-price-sale"] [data-testid="product-price-item-price"]').first();
  if (sale.length) return parseTryPrice(sale.text().trim());
  const old = $('[data-testid="product-price-old"] [data-testid="product-price-item-price"]').first();
  if (old.length) return parseTryPrice(old.text().trim());
  return parseTryPrice($('[data-testid="product-price-item-price"]').first().text().trim());
}

// Beden butonlarının modifier class'ları GERÇEK bir örnekle doğrulandı — üç
// durumun üçü de aynı sayfada görüldü:
//   "--few-units"              -> "Tükenmek üzere" metniyle, az kaldı
//   "--out-of-stock-selectable"-> "Benzer ürünlere bak" metniyle, tükendi
//     (buton yine tıklanabilir ama satın alınamaz durumda)
//   (modifier yok)             -> stokta
function classifySizeAvailability($button) {
  const classes = ($button.attr('class') || '').split(/\s+/);
  if (classes.some((c) => c.includes('--out-of-stock'))) return 'out_of_stock';
  if (classes.some((c) => c.includes('--few-units'))) return 'low_stock';
  return 'in_stock';
}

function extractSizes($) {
  const sizes = [];
  $('oy-product-size-selector button[data-testid="product-size-selector-item"]').each((_, el) => {
    const $el = $(el);
    const label = $el.find('span').first().text().trim();
    if (label) {
      sizes.push({ size: label, availability: classifySizeAvailability($el) });
    }
  });
  return sizes;
}

function extractColorIdFromUrl(url) {
  try {
    return new URL(url).searchParams.get('colorId');
  } catch {
    return null;
  }
}

// SINIRLAMA: Oysho'nun renk görselinin dosya adı (ör. ".../34257169685-m10/
// ...jpg") diğer İnditex markalarındaki gibi productId+colorId birleşimi
// deseni izlemiyor (rastgele bir medya id'si gibi görünüyor) — bu yüzden
// SEÇİLİ OLMAYAN renklerin colorId'sini DOM'dan güvenilir şekilde
// çıkaramıyoruz. Şimdilik sadece SEÇİLİ rengi (zaten sourceUrl'in kendi
// ?colorId= parametresinden biliyoruz) relatedColors'a ekliyoruz. Birden
// fazla renkli bir ürün örneği paylaşılırsa (renk değişince URL'in nasıl
// güncellendiği görülürse) bu genişletilebilir.
function extractRelatedColors($, sourceUrl) {
  const colors = [];
  const currentColorId = extractColorIdFromUrl(sourceUrl);
  $('[data-testid="product-color-item"]').each((_, el) => {
    const $el = $(el);
    const ariaLabel = ($el.attr('aria-label') || '').trim();
    const classes = ($el.attr('class') || '').split(/\s+/);
    const selected = /seçildi$/i.test(ariaLabel) || classes.some((c) => c.endsWith('--selected'));
    const name = ariaLabel.replace(/\s*seçildi\s*$/i, '').trim();
    if (!name || !selected) return;
    colors.push({ name, colorId: currentColorId, url: sourceUrl, selected: true });
  });
  return colors;
}

function extractProductIdFromUrl(url) {
  // "...-l35114492" — İnditex'in Pull&Bear/Massimo Dutti/Stradivarius ile
  // paylaştığı ürün-satır kodu deseni.
  const match = (url || '').split('?')[0].match(/-l(\d+)$/i);
  return match ? match[1] : null;
}

function extractMeta($) {
  // og:title CANLI testte "Ürün adı | OYSHO Türkiye | İndirim" gibi BİRDEN
  // FAZLA "|" ile ayrılmış son ek taşıdığı görüldü (sadece <title>
  // fallback'ini değil, og:title'ı da temizlemek gerekiyor). İlk "|"
  // karakterinden öncesini almak, kaç son ek olduğunu bilmeye gerek kalmadan
  // işe yarıyor.
  const rawName = $('meta[property="og:title"]').attr('content') || $('title').first().text() || null;
  const name = rawName ? rawName.split('|')[0].trim() : null;
  const imageUrl = $('meta[property="og:image"]').attr('content') || null;
  return { name, imageUrl };
}

/**
 * Oysho ürün sayfası HTML'inden fiyat/stok verisini çıkarır. Sayfa tek bir
 * rengin bedenlerini gösterir; kardeş renkler `relatedColors` alanında
 * (yalnızca güvenilir şekilde tespit edilebilen SEÇİLİ renk için) yer alır.
 */
function parseOyshoProduct(html, sourceUrl) {
  const $ = cheerio.load(html);
  const { price, currency } = extractPrice($);
  const sizeEntries = extractSizes($);
  const productId = extractProductIdFromUrl(sourceUrl);
  const meta = extractMeta($);
  const relatedColors = extractRelatedColors($, sourceUrl);
  const activeColor = relatedColors.find((c) => c.selected);
  const colorId = activeColor ? activeColor.colorId : extractColorIdFromUrl(sourceUrl);
  const colorName = activeColor ? activeColor.name : 'Tek Renk';

  if (!productId && sizeEntries.length === 0 && price == null) {
    return null;
  }

  const variants = sizeEntries.map((entry, index) => ({
    sku: `${productId || 'oysho'}-${colorId || colorName}-${entry.size || index}`,
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
    brand: 'Oysho',
    imageUrl: meta.imageUrl,
    canonicalUrl: sourceUrl,
    checkedAt: new Date().toISOString(),
    variants,
    relatedColors,
  };
}

module.exports = {
  id: 'oysho',
  label: 'Oysho',
  hostnames: ['oysho.com'],
  parse: (html, url) => parseOyshoProduct(html, url),
  // ÖLÇÜM: beden butonları ~0,2-2sn'de geliyor (ilk ölçümde 0,5sn toplam).
  fetchProfile: {
    ready: () => !!document.querySelector('oy-product-size-selector button[data-testid="product-size-selector-item"]'),
  },
  // testler için:
  parseOyshoProduct,
  extractPrice,
  extractSizes,
  extractRelatedColors,
  classifySizeAvailability,
  extractProductIdFromUrl,
};
