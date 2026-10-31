const cheerio = require('cheerio');
const { parseTryPrice } = require('../priceUtils');

// Mango, Next.js + CSS Modules ile render ediyor: class adları
// "SinglePrice-module__y_asRG__center" gibi derleme-bazlı bir hash içeriyor
// (__y_asRG__). Bu hash yeni bir deploy'da değişebilir — bu yüzden mümkün
// olan yerlerde HASH İÇERMEYEN sinyalleri tercih ediyoruz:
//   - beden butonlarının id'si: "product.sizeSelector.available.20" (Mango'nun
//     kendi domain isimlendirmesi, hash yok, en stabil sinyal)
//   - renk seçicideki img alt metni: "Renk X" / "Seçilen renk X" (yine hash yok)
// Fiyat ve renk-listesi konteyneri için ise class adının HASH'siz kısmına
// (`[class*="SinglePrice-module"]` gibi) kısmi eşleşme yapıyoruz — modül adı
// muhtemelen hash'ten daha uzun ömürlü olur ama yine de kırılgan, deploy
// sonrası doğrulama gerekebilir.

// Beden buton id'sindeki orta segment durumu kodluyor: doğrulanmış iki durum
// var artık — "available" (stokta) ve "unavailable" (tükendi, gerçek bir
// örnekle doğrulandı: aria-disabled="true" + "Chip-module__QaOlMW__disabled"
// + "ChipSize-module__hqfyDW__outOfStock" sınıfları + "Mevcut değil.
// İstiyorum!" ekran-okuyucu metniyle birlikte geliyor). "lowstock"/
// "comingsoon" gibi diğer durumlar henüz gerçek bir örnekle görülmedi, yine
// de Mango'nun kendi isimlendirme mantığına dayanan makul bir tahmin olarak
// bırakıldı — gerçek örnek gelirse doğrulanmalı. aria-disabled="true" tek
// başına da (id'deki state'ten bağımsız olarak) tükendi için yeterli sinyal.
function classifySizeAvailability($button) {
  const id = $button.attr('id') || '';
  const ariaDisabled = $button.attr('aria-disabled') === 'true';
  const idMatch = id.match(/^product\.sizeSelector\.([a-zA-Z]+)\./);
  const idState = idMatch ? idMatch[1].toLowerCase() : null;

  if (ariaDisabled || idState === 'soldout' || idState === 'outofstock' || idState === 'unavailable') {
    return 'out_of_stock';
  }
  if (idState === 'lowstock' || idState === 'lastunits') return 'low_stock';
  if (idState === 'comingsoon' || idState === 'preorder') return 'coming_soon';
  return 'in_stock';
}

// Fiyat: Mango schema.org işaretlemesini (itemprop="price" content="3999.99")
// sayfada tutuyor — derleme-bazlı CSS sınıflarından (hash'li, her deploy'da
// değişir; 2026-10'da değişti ve tüm canlı Mango taramaları PARSE_FAILED oldu)
// çok daha kararlı. İndirimli üründe iki fiyat var (eski + güncel): güncel
// olan her zaman daha düşüktür, bu yüzden en küçüğünü alıyoruz.
// Yedek: eski sınıf tabanlı okuma (itemprop'u olmayan eski sayfalar/fixture'lar).
function extractPrice($) {
  const prices = $('[itemprop="price"]')
    .map((_, el) => Number($(el).attr('content') ?? $(el).text().replace(/[^\d.]/g, '')))
    .get()
    .filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length > 0) {
    const currency = $('[itemprop="priceCurrency"]').first().attr('content') || 'TRY';
    return { price: Math.min(...prices), currency };
  }

  const finalPriceEl = $('[class*="SinglePrice-module"][class*="finalPrice"]').first();
  const text = finalPriceEl.length
    ? finalPriceEl.text().trim()
    : $('[class*="SinglePrice-module"]').last().text().trim();
  return parseTryPrice(text);
}

// Beden etiketi: butonun içindeki ilk "yaprak" metin (S, M, XL...). Aynı butonda
// "Mevcut değil. İstiyorum!" gibi ekran-okuyucu metinleri de oluyor ama hep
// etiketten SONRA geliyor; sınıf adına bağımlı değil.
function sizeLabel($button) {
  const leaf = $button
    .find('*')
    .filter((_, el) => el.children.every((c) => c.type === 'text'))
    .map((_, el) => el.children.map((c) => c.data).join('').trim())
    .get()
    .find(Boolean);
  return leaf || $button.contents().first().text().trim();
}

function extractSizes($) {
  const sizes = [];
  $('button[id^="product.sizeSelector."]').each((_, el) => {
    const $el = $(el);
    const label = sizeLabel($el);
    if (label) {
      sizes.push({
        size: label,
        availability: classifySizeAvailability($el),
        buttonId: $el.attr('id') || null,
      });
    }
  });
  return sizes;
}

// URL yapısı: ".../<ürün-adı-slug>/<productId>/<colorId>/00" — son iki
// segment renk ve (şimdilik hep sabit görünen) beden/varyant koduna karşılık
// geliyor.
function parseUrlSegments(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/(\d{5,})\/(\d+)\/(\d+)\/?$/);
    if (match) return { productId: match[1], colorId: match[2] };
  } catch {
    /* geçersiz url */
  }
  return { productId: null, colorId: null };
}

// Renk seçici görselleri "Renk <ad>" / "Seçilen renk <ad>" alt metni taşıyor
// (erişilebilirlik metni — sınıf adlarından çok daha kararlı).
const COLOR_ALT = /^(Seçilen\s+)?renk\s+(.+)$/i;

function extractColorName($) {
  const alt = $('img[alt]')
    .map((_, el) => $(el).attr('alt') || '')
    .get()
    .find((a) => /^Seçilen\s+renk\s+/i.test(a));
  if (alt) return alt.replace(/^Seçilen\s+renk\s+/i, '').trim() || null;

  // Yedek: eski sınıf tabanlı seçim.
  const legacy = $('[class*="ColorBullet-module"][class*="selected"] img').first().attr('alt') || '';
  return legacy.replace(/^Seçilen renk\s+/i, '').trim() || null;
}

// Seçili renk sayfada bir <a> değil, düz bir <span> olarak duruyor (zaten
// üzerinde olduğumuz sayfa); diğer renkler <a href="..."> ile kardeş
// sayfalara link veriyor. H&M/Bershka'daki relatedColors modeliyle aynı fikir.
function extractRelatedColors($, baseUrl) {
  const colors = [];
  const seen = new Set();
  $('img[alt]').each((_, img) => {
    const $img = $(img);
    const match = ($img.attr('alt') || '').match(COLOR_ALT);
    if (!match) return;
    const name = match[2].trim();
    const selected = !!match[1];
    const $li = $img.closest('li');
    if (!$li.length || seen.has(name)) return; // öneri/başka liste görselleri li içinde olmayabilir
    seen.add(name);

    const href = $li.find('a[href]').first().attr('href');
    let url = baseUrl;
    if (href) {
      try {
        url = new URL(href, baseUrl).toString();
      } catch {
        /* baseUrl geçersizse href'i olduğu gibi bırak */
      }
    }
    colors.push({ name, colorId: parseUrlSegments(url).colorId, url, selected });
  });
  return colors;
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
 * Mango ürün sayfası HTML'inden fiyat/stok verisini çıkarır. Sayfa tek bir
 * rengin bedenlerini gösterir (URL'deki .../<productId>/<colorId>/00 ile
 * belirlenir); kardeş renkler `relatedColors` alanında ayrı url+colorId
 * olarak yer alır.
 */
function parseMangoProduct(html, sourceUrl) {
  const $ = cheerio.load(html);
  const { price, currency } = extractPrice($);
  const sizeEntries = extractSizes($);
  const meta = extractMeta($, sourceUrl);
  // ÖNEMLİ: canonicalUrl'i (meta.canonicalUrl) BURADA productId/colorId
  // çıkarmak için kullanmıyoruz. Canlı test sırasında keşfedildi: Mango'nun
  // <link rel="canonical"> etiketi her zaman sabit bir "varsayılan renk"
  // sayfasına işaret ediyor — GERÇEKTE ÇEKİLEN rengin URL'ine değil. Yani
  // "Kahverengi" (colorId=30) sayfasını çeksek bile canonical hâlâ
  // ".../56/00" (Lacivert) diyebiliyor. Bu yüzden ürün/renk kimliğini
  // gerçekten istek attığımız sourceUrl'den çıkarıyoruz; meta.canonicalUrl
  // sadece isim/görsel meta verisi için kullanılıyor.
  let pageUrl = sourceUrl;
  let { productId, colorId } = parseUrlSegments(pageUrl);
  // İSTİSNA: eski biçimli URL'ler (".../<slug>_17021231", arama motorlarında
  // ve eski paylaşımlarda hâlâ dolaşıyor) sitede yeni biçime yönleniyor ama
  // istek URL'inde ürün/renk kodu YOK. Canlı testte bu durumda productId'nin
  // URL'in kendisi, SKU'nun "mango-Lacivert-S" olduğu görüldü; kalıcı URL de
  // eski biçimde kaldığından aynı ürünün yeni biçimli URL'iyle aynı hedefe
  // eşlenmiyordu (bkz. routes/products.js dedup anahtarı). Yönlenen sayfa
  // (canonical'ın da işaret ettiği varsayılan renk sayfası) yeni biçimde
  // olduğundan, SADECE bu durumda kimliği canonical'dan alıyoruz; yukarıdaki
  // "canonical yanıltıcı olabilir" uyarısı istek URL'i kodluyken hâlâ geçerli.
  if (!productId) {
    const fromCanonical = parseUrlSegments(meta.canonicalUrl);
    if (fromCanonical.productId) {
      ({ productId, colorId } = fromCanonical);
      pageUrl = meta.canonicalUrl;
    }
  }
  const colorName = extractColorName($) || 'Tek Renk';
  const relatedColors = extractRelatedColors($, pageUrl);

  if (!productId && sizeEntries.length === 0 && price == null) {
    return null;
  }

  const variants = sizeEntries.map((entry, index) => ({
    sku: `${productId || 'mango'}-${colorId || colorName}-${entry.size || index}`,
    color: colorName,
    size: entry.size,
    price,
    currency,
    availability: entry.availability,
    url: pageUrl,
  }));

  return {
    productId: productId || sourceUrl,
    name: meta.name,
    brand: 'Mango',
    imageUrl: meta.imageUrl,
    canonicalUrl: pageUrl,
    checkedAt: new Date().toISOString(),
    variants,
    relatedColors,
  };
}

module.exports = {
  id: 'mango',
  label: 'Mango',
  hostnames: ['mango.com', 'shop.mango.com'],
  parse: (html, url) => parseMangoProduct(html, url),
  // ÖLÇÜM: Mango'da bot koruması yok — düz fetch (JS çalıştırmadan) tam veriyi
  // döndürüyor (~0,6sn, 305KB SSR HTML, fiyat/beden/stok dahil). Bu yüzden
  // Chromium'a hiç düşmüyoruz; sadece düz fetch beklenmedik şekilde boş/engelli
  // gelirse tarayıcıya kademeleniyor (bkz. scraper/fetchHtml.js).
  fetchProfile: {
    plainFetchWorks: true,
    ready: () => !!document.querySelector('button[id^="product.sizeSelector."]'),
  },
  // testler için:
  parseMangoProduct,
  extractPrice,
  extractSizes,
  extractColorName,
  extractRelatedColors,
  classifySizeAvailability,
  parseUrlSegments,
};
