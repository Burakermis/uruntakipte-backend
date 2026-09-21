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

// İndirimli ürünlerde fiyat İKİ ayrı blok olarak geliyor: üstü çizili eski
// fiyat ve "finalPrice" sınıfıyla işaretli güncel fiyat (bkz. gerçek örnek:
// "SinglePrice-module__y_asRG__finalPrice" sınıflı span). Bu sınıf varsa onu
// önceliklendiriyoruz — DOM sırasına (son eşleşen eleman) güvenmek yerine
// açıkça "bu güncel fiyat" diyen sinyali kullanmak indirimsiz/indirimli her
// iki durumda da daha güvenilir. "finalPrice" yoksa (indirimsiz ürün) tek
// fiyat bloğu kalır, en içteki (son eşleşen) span'e düşülür.
function extractPrice($) {
  const finalPriceEl = $('[class*="SinglePrice-module"][class*="finalPrice"]').first();
  const text = finalPriceEl.length
    ? finalPriceEl.text().trim()
    : $('[class*="SinglePrice-module"]').last().text().trim();
  return parseTryPrice(text);
}

function extractSizes($) {
  const sizes = [];
  $('button[id^="product.sizeSelector."]').each((_, el) => {
    const $el = $(el);
    const label = $el.find('[class*="SizeLabel-module"]').first().text().trim();
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

function extractColorName($) {
  const img = $('[class*="ColorBullet-module"][class*="selected"] img').first();
  const alt = img.attr('alt') || '';
  return alt.replace(/^Seçilen renk\s+/i, '').trim() || null;
}

// Seçili renk sayfada bir <a> değil, düz bir <span> olarak duruyor (zaten
// üzerinde olduğumuz sayfa); diğer renkler <a href="..."> ile kardeş
// sayfalara link veriyor. H&M/Bershka'daki relatedColors modeliyle aynı fikir.
function extractRelatedColors($, baseUrl) {
  const colors = [];
  $('[class*="ColorList-module"][class*="colorsList"] > li').each((_, li) => {
    const $li = $(li);
    const $a = $li.find('a').first();
    const $img = $li.find('img').first();
    const altRaw = $img.attr('alt') || '';
    const selected = /^Seçilen renk/i.test(altRaw) || $li.find('[class*="selected"]').length > 0;
    const name = altRaw.replace(/^Seçilen renk\s+/i, '').replace(/^Renk\s+/i, '').trim();
    if (!name) return;

    let url = baseUrl;
    if ($a.length && $a.attr('href')) {
      try {
        url = new URL($a.attr('href'), baseUrl).toString();
      } catch {
        /* baseUrl geçersizse href'i olduğu gibi bırak */
      }
    }
    const { colorId } = parseUrlSegments(url);
    colors.push({ name, colorId, url, selected });
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
