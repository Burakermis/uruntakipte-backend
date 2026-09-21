const cheerio = require('cheerio');
const { parseTryPrice } = require('../priceUtils');

// H&M'in beden butonlarındaki data-testid'i "002-in-stock", "004-few-pieces-left",
// "005-out-of-stock" gibi temiz bir sözlükle kodluyor — Zara'nın data-qa-action'ı
// kadar (hatta ondan daha) stabil bir sinyal. Baştaki "\d+-" öneki numaralandırma,
// geri kalanı durumu veriyor.
const TESTID_AVAILABILITY_MAP = {
  'in-stock': 'in_stock',
  'few-pieces-left': 'low_stock',
  'out-of-stock': 'out_of_stock',
  'coming-soon': 'coming_soon',
};

// data-testid deseni değişirse diye, aria-label'daki Türkçe ifadeyi de
// ikincil bir kaynak olarak deniyoruz (Zara'daki çoklu-kaynak yaklaşımıyla
// aynı prensip: tek bir DOM detayına tam bağımlı kalma).
const ARIA_LABEL_AVAILABILITY = [
  { pattern: /stokta yok/i, availability: 'out_of_stock' },
  { pattern: /birkaç adet kaldı/i, availability: 'low_stock' },
  { pattern: /yakında/i, availability: 'coming_soon' },
  { pattern: /stokta/i, availability: 'in_stock' },
];

function extractProductIdFromUrl(url) {
  const match = (url || '').match(/productpage\.(\d+)\.html/);
  return match ? match[1] : null;
}

function extractPrice($) {
  const text = $('[data-testid="white-price"]').first().text().trim();
  return parseTryPrice(text);
}

function extractSizes($) {
  const sizes = [];
  $('ul[data-testid="grid"] li [role="radio"]').each((_, el) => {
    const $el = $(el);
    const label = $el.text().replace(/ /g, ' ').trim();
    const ariaLabel = $el.attr('aria-label') || '';
    const testId = $el.find('[data-testid]').first().attr('data-testid') || '';

    let availability = null;
    const suffixMatch = testId.match(/^\d+-(.+)$/);
    if (suffixMatch && TESTID_AVAILABILITY_MAP[suffixMatch[1]]) {
      availability = TESTID_AVAILABILITY_MAP[suffixMatch[1]];
    } else {
      const found = ARIA_LABEL_AVAILABILITY.find((rule) => rule.pattern.test(ariaLabel));
      availability = found ? found.availability : 'unknown';
    }

    if (label) {
      sizes.push({ size: label, availability, buttonId: $el.attr('id') || null });
    }
  });
  return sizes;
}

// ÖNEMLİ MİMARİ FARK: Zara'da tüm renkler TEK sayfanın JSON-LD'sinde birlikte
// gelir. H&M'de her renk AYRI bir ürün sayfası/URL'dir (örn.
// productpage.1336969003.html = Beyaz, productpage.1336969002.html = Haki) —
// renk seçici sadece bu kardeş sayfalara link veriyor, veriyi kendi içinde
// taşımıyor. Bu yüzden burada tek yapabileceğimiz: (a) şu an üzerinde
// olduğumuz sayfanın kendi rengini doğru isimlendirmek, (b) diğer renklerin
// URL'lerini "relatedColors" olarak not düşmek (ileride ayrı takip kaydı
// olarak eklenebilsinler diye) — onları da tek bir "ürün"müş gibi zorla
// birleştirmiyoruz, çünkü değiller.
function extractColorName($) {
  const text = $('[data-testid="color-selector"] p').first().text().trim();
  return text || null;
}

function extractRelatedColors($, baseUrl) {
  const colors = [];
  $('[data-testid="color-selector"] div[data-testid="grid"] > a[role="radio"]').each((_, el) => {
    const $el = $(el);
    const name = $el.attr('title') || null;
    const href = $el.attr('href');
    if (!name || !href) return;
    let url = href;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      /* baseUrl geçersizse href'i olduğu gibi bırak */
    }
    colors.push({
      name,
      url,
      selected: $el.attr('aria-checked') === 'true',
      swatchImage: $el.find('img').attr('src') || null,
    });
  });
  return colors;
}

// og:title / og:image, hemen hemen her sitede (sosyal paylaşım kartları için)
// bulunan, marka-bağımsız stabil meta etiketleri — H&M'in kendi sayfa
// yapısını bilmeden bile makul bir isim/görsel çıkarımı sağlıyor.
function extractMeta($) {
  // H&M'in og:title'ı diğer markalardan FARKLI bir ayırıcı kullanıyor:
  // "Ürün adı - Renk - H&M TR" ("|" değil "-"). Ürün adının kendisi de
  // meşru "-" karakterleri içerebileceği için (ör. "Slim Fit - Uzun Kollu")
  // körü körüne ilk "-"'dan bölmek yanlış olur — bunun yerine SADECE sondaki
  // bilinen "- H&M TR" marka son ekini hedefliyoruz.
  const rawName = $('meta[property="og:title"]').attr('content') || $('title').first().text() || null;
  const name = rawName ? rawName.replace(/\s*-\s*H&M(\s+TR)?\s*$/i, '').trim() : null;
  const imageUrl = $('meta[property="og:image"]').attr('content') || null;
  const canonicalUrl = $('link[rel="canonical"]').attr('href') || null;
  return { name, imageUrl, canonicalUrl };
}

/**
 * H&M ürün sayfası HTML'inden fiyat/stok verisini çıkarır. Her sayfa TEK bir
 * renge karşılık geldiği için dönen `variants` de o tek rengin bedenlerini
 * içerir; kardeş renkler `relatedColors` alanında ayrı ayrı URL olarak yer alır.
 */
function parseHmProduct(html, sourceUrl) {
  const $ = cheerio.load(html);
  const { price, currency } = extractPrice($);
  const sizeEntries = extractSizes($);
  const { name, imageUrl, canonicalUrl } = extractMeta($);
  const resolvedUrl = canonicalUrl || sourceUrl;
  const productId = extractProductIdFromUrl(resolvedUrl);
  const colorName = extractColorName($) || 'Tek Renk';
  const relatedColors = extractRelatedColors($, resolvedUrl);

  if (!productId && sizeEntries.length === 0 && price == null) {
    // Hiçbir sinyal yakalanamadı — muhtemelen bot-engeli sayfası ya da
    // sayfa yapısı tahmin ettiğimizden çok farklı.
    return null;
  }

  const variants = sizeEntries.map((entry, index) => ({
    sku: `${productId || 'hm'}-${entry.buttonId || index}`,
    color: colorName,
    size: entry.size,
    price,
    currency,
    availability: entry.availability,
    url: resolvedUrl,
  }));

  return {
    productId: productId || resolvedUrl,
    name,
    brand: 'H&M',
    imageUrl,
    canonicalUrl: resolvedUrl,
    checkedAt: new Date().toISOString(),
    variants,
    relatedColors,
  };
}

module.exports = {
  id: 'hm',
  label: 'H&M',
  hostnames: ['hm.com', 'www2.hm.com'],
  parse: (html, url) => parseHmProduct(html, url),
  // ÖLÇÜM: düz fetch 403 alıyor, stealth'li headless Chromium ise HTTP 200 +
  // 322 baytlık "Access Denied" — ama engel IP'den DEĞİL (aynı IP'den normal
  // bir tarayıcı sayfayı açıyor), otomasyonun tanınmasından. Stealth'siz,
  // pencereli, `--enable-automation`sız bir tarayıcıyla 10/10 canlı sayfa
  // alındı (bkz. browserFetch.js launchBrowser). Düz fetch yine boşuna.
  fetchProfile: {
    headed: true,
    // Soğuk bağlamda Akamai'nin ~2,7KB'lık ara sayfası kendi kendine çözülene
    // kadar 3-5sn sürüyor; varsayılan 2sn bunu "engel" sanıp vazgeçiyordu
    // (canlı testte ilk istek 12sn'ye uzadı).
    blockGraceMs: 9000,
    ready: () => !!document.querySelector('ul[data-testid="grid"] li [role="radio"]'),
  },
  // testler için:
  parseHmProduct,
  extractPrice,
  extractSizes,
  extractColorName,
  extractRelatedColors,
  parseTryPrice,
};
