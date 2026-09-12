const cheerio = require('cheerio');

// Zara PDP'lerinde availability üç kademe: 'in_stock' > 'low_on_stock' > 'coming_soon' / 'out_of_stock'.
// JSON-LD sadece InStock/OutOfStock/LimitedAvailability bilir, low_on_stock ve coming_soon'u ayırt edemez.
const LD_AVAILABILITY_MAP = {
  'https://schema.org/InStock': 'in_stock',
  'https://schema.org/OutOfStock': 'out_of_stock',
  'https://schema.org/LimitedAvailability': 'low_stock',
};

// Beden seçici butonlarındaki data-qa-action, o an ekranda aktif olan renk için
// gerçek zamanlı stok durumunu taşır. Kullanıcı arayüzünde ne görünüyorsa o.
// "size-out-of-stock" görünüyor olsa da buton hâlâ tıklanabilir (benzer ürün önerisi
// açar) — bu bedenin tükendiği anlamına gelir, hata değildir.
const DOM_ACTION_MAP = {
  'size-in-stock': 'in_stock',
  'size-low-on-stock': 'low_stock',
  'size-back-soon': 'coming_soon',
  'size-out-of-stock': 'out_of_stock',
};

// window.zara.viewPayload kendi ham etiketlerini kullanıyor (örn. "low_on_stock").
// Üç kaynağı (DOM/viewPayload/JSON-LD) ortak bir sözlüğe normalize ediyoruz ki
// tüketen kod (DB, bildirim eşiği) tek bir enum'a göre karar versin.
const VIEW_PAYLOAD_AVAILABILITY_MAP = {
  in_stock: 'in_stock',
  low_on_stock: 'low_stock',
  coming_soon: 'coming_soon',
  out_of_stock: 'out_of_stock',
};

function extractJsonLd($) {
  const raw = $('script[type="application/ld+json"]').first().html();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// window.zara.viewPayload = {...}; büyük bir inline script içinde gömülü.
// Regex ile tek satırda yakalamak nested braces yüzünden güvenilir değil,
// bu yüzden "= {" başlangıcından itibaren brace sayacıyla dengeli bloğu buluyoruz.
function extractViewPayload(html) {
  const marker = 'window.zara.viewPayload = ';
  const start = html.indexOf(marker);
  if (start === -1) return null;

  const objStart = start + marker.length;
  if (html[objStart] !== '{') return null;

  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escaped = false;

  for (let i = objStart; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = html.slice(objStart, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Şu an ekranda seçili olan rengin adını döner (örn. "Ekru").
function extractSelectedColorName($) {
  const name = $('.product-color-extended-name__name').first().text().trim();
  return name || null;
}

// Aktif renk için beden butonlarından { sizeLabel -> availability } haritası çıkarır.
function extractDomSizeStock($) {
  const stock = new Map();
  $('.size-selector-sizes__size').each((_, li) => {
    const $li = $(li);
    const action = $li.find('button.size-selector-sizes-size__button').attr('data-qa-action');
    const label = $li.find('[data-qa-qualifier="size-selector-sizes-size-label"]').first().text().trim();
    if (label && action && DOM_ACTION_MAP[action]) {
      stock.set(label, DOM_ACTION_MAP[action]);
    }
  });
  return stock;
}

// JSON-LD'nin composite sku'su "{catentryId}-{colorId}-{sizeId}" formatında
// (örn. "552352094-712-2" = renk 712, beden id 2). viewPayload'daki gerçek SKU
// numarası bununla eşleşmiyor, ama color.id + size.id ikilisi birebir eşleşiyor.
// Bu yüzden index'i "{colorId}-{sizeId}" anahtarıyla kuruyoruz.
function buildSizeAvailabilityIndex(viewPayload) {
  const index = new Map();
  const colors = viewPayload?.product?.detail?.colors || [];
  for (const color of colors) {
    for (const size of color.sizes || []) {
      if (color.id != null && size.id != null) {
        index.set(`${color.id}-${size.id}`, {
          availability: size.availability || null,
          demand: size.demand || null,
        });
      }
    }
  }
  return index;
}

function colorSizeKeyFromLdSku(sku) {
  const parts = String(sku).split('-');
  if (parts.length < 3) return null;
  return `${parts[1]}-${parts[2]}`;
}

/**
 * Zara PDP HTML'inden fiyat/stok verisini çıkarır.
 * @param {string} html - Sayfanın tam HTML kaynağı
 * @returns {object|null} Yapılandırılmış ürün verisi
 */
function parseZaraProduct(html) {
  const $ = cheerio.load(html);
  const ld = extractJsonLd($);
  if (!ld) return null;

  const viewPayload = extractViewPayload(html);
  const skuAvailabilityIndex = viewPayload ? buildSizeAvailabilityIndex(viewPayload) : new Map();

  const selectedColor = extractSelectedColorName($);
  const domSizeStock = extractDomSizeStock($);

  const canonicalUrl = $('link[rel="canonical"]').attr('href') || ld.url || null;
  const productId = ld.productGroupID || null;

  const variants = (ld.hasVariant || []).map((variant) => {
    const offer = variant.offers || {};
    const ldAvailability = LD_AVAILABILITY_MAP[offer.availability] || 'unknown';

    // Öncelik: DOM (o an ekranda gösterilen aktif renk için gerçek, en granüler durum)
    //        > viewPayload (tüm renkler için granüler durum, ama JS-gömülü blok kırılgan)
    //        > JSON-LD (her renk için var ama in/out ikili, low_stock/coming_soon ayrımı yok)
    let availability = ldAvailability;
    let source = 'json-ld';

    const colorSizeKey = colorSizeKeyFromLdSku(variant.sku);
    const viewPayloadEntry = skuAvailabilityIndex.get(colorSizeKey);
    if (viewPayloadEntry?.availability) {
      availability = VIEW_PAYLOAD_AVAILABILITY_MAP[viewPayloadEntry.availability] || viewPayloadEntry.availability;
      source = 'view-payload';
    }

    if (selectedColor && variant.color === selectedColor && domSizeStock.has(variant.size)) {
      availability = domSizeStock.get(variant.size);
      source = 'dom';
    }

    // DİKKAT: variant.sku'nun ilk segmenti (catentryId) taramalar arasında
    // DEĞİŞEBİLİYOR — aynı ürün/renk/beden için art arda iki taramada farklı
    // değer gözlemlendi (üretimde 539592134 → 539592136). Bu segmenti
    // kalıcı kimlik olarak saklarsak bir sonraki taramada eşleşmez: hem
    // checker.js'in abonelik eşlemesi hem de "beden ekle"deki VARIANT_NOT_FOUND
    // kontrolü sessizce bozulur. color.id + size.id ikilisi (colorSizeKey)
    // taramalar arasında STABİL kalıyor (viewPayload eşlemesi zaten buna
    // dayanıyor) — kalıcı sku'yu bunun ve URL'den gelen stabil productId'nin
    // birleşiminden kuruyoruz.
    const sku = productId && colorSizeKey ? `${productId}-${colorSizeKey}` : variant.sku;

    return {
      sku,
      color: variant.color,
      size: variant.size,
      price: offer.price != null ? Number(offer.price) : null,
      currency: offer.priceCurrency || null,
      availability,
      availabilitySource: source,
      url: offer.url || canonicalUrl,
    };
  });

  return {
    productId: ld.productGroupID || null,
    name: ld.name || null,
    brand: ld.brand?.name || null,
    imageUrl: Array.isArray(ld.image) ? ld.image[0] : ld.image || null,
    canonicalUrl,
    checkedAt: new Date().toISOString(),
    variants,
  };
}

// Registry'nin beklediği ortak adapter arayüzü: { id, label, hostnames, parse(html) }.
// Yeni bir marka eklemek = bu şekli dolduran bir dosya yazıp registry.js'e eklemek.
module.exports = {
  id: 'zara',
  label: 'ZARA',
  hostnames: ['zara.com'],
  parse: parseZaraProduct,
  // browserFetch.js sayfayı 'commit' anında bırakır ve SADECE bu koşulun
  // gerçekleşmesini bekler (bkz. scraper/browserFetch.js). ÖLÇÜM: Zara
  // PDP'sinde application/ld+json script'i HİÇ gelmiyor (eskiden onu
  // bekliyorduk, her taramada tam 3sn boşa gidiyordu); parse'ın asıl
  // dayandığı window.zara.viewPayload ise navigasyondan ~0,4sn sonra hazır.
  fetchProfile: {
    ready: () => !!(window.zara && window.zara.viewPayload),
  },
  // İç fonksiyonlar test dosyalarının doğrudan erişebilmesi için de dışa açık:
  parseZaraProduct,
  extractJsonLd,
  extractViewPayload,
  extractDomSizeStock,
};
