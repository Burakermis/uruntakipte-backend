const fs = require('fs');
const path = require('path');
const { fetchHtmlWithBrowser } = require('./browserFetch');
const { brandFetchProfile } = require('./registry');

// DEV-ONLY: bazı siteler (Akamai vb.) hem plain fetch hem de headless
// tarayıcıyı engelleyebilir. Geliştirme/test sırasında akışın uçtan uca
// çalıştığını gösterebilmek için, bilinen bir demo URL'ine her iki yol da
// başarısız olursa yerel fixture'a düşüyoruz. Üretimde KAPALI olmalı
// (bkz. ALLOW_FIXTURE_FALLBACK).
const DEV_FIXTURES = {
  'https://www.zara.com/tr/tr/aaron-levine-x-zara-uzun-kollu-t-shirt-p01887320.html':
    path.join(__dirname, '..', 'fixtures', 'zara-aaron-levine-tshirt.html'),
  'https://www2.hm.com/tr_tr/productpage.1336969003.html':
    path.join(__dirname, '..', 'fixtures', 'hm-product-snippet.html'),
};

const ALLOW_FIXTURE_FALLBACK = process.env.NODE_ENV !== 'production';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
};

function normalizeForFixtureLookup(url) {
  return url.split('?')[0].replace(/\/$/, '');
}

// HTTP 200 dönse bile içerik bot-doğrulama/interstitial sayfası olabilir
// (örn. Akamai "bm-verify" yönlendirmesi — gerçek ürün HTML'i değil, birkaç
// yüz baytlık bir meta-refresh sayfası). Böyle sayfalar birkaç yüz/birkaç bin
// bayt uzunluğunda olur; gerçek bir ürün sayfası (JSON-LD kullansın ya da
// kullanmasın, ör. Mango) her zaman çok daha uzundur. NOT: önceden
// application/ld+json varlığını da şart koşuyorduk, ama bu her markada
// geçerli değil (Mango JSON-LD kullanmıyor) — sadece uzunluk yeterli.
function looksLikeBlockedResponse(html) {
  return !html || html.length < 5000;
}

async function tryPlainFetch(url, timeoutMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return await res.text();
  } catch {
    // network hatası / timeout — üst katman bir sonraki kademeye düşer
  }
  return null;
}

/**
 * Bir URL'in HTML'ini indirmeye çalışır, kademeli olarak:
 *   1) düz fetch — SADECE bunun işe yaradığı bilinen markalarda (şu an
 *      yalnızca Mango; bkz. brands/*.js fetchProfile.plainFetchWorks).
 *      Diğer yedi markada bu istek ölçümle doğrulanmış şekilde HER ZAMAN
 *      ~2,4KB'lık Akamai ara sayfasına (ya da H&M'de 403'e) düşüyordu —
 *      yani her taramaya boşuna ~0,2-1,2sn ekliyordu, artık atlanıyor.
 *   2) gerçek headless tarayıcı (Playwright)
 *   3) tarayıcı da engelli/boş döndüyse: ısınma navigasyonlu ikinci deneme
 *   4) (sadece dev modunda) bilinen bir demo URL'i için kayıtlı fixture
 * Hepsi başarısız olursa null döner.
 */
async function fetchHtml(url, { timeoutMs = 10000, brandId } = {}) {
  const { plainFetchWorks } = brandFetchProfile(brandId);

  if (plainFetchWorks) {
    const plainHtml = await tryPlainFetch(url, timeoutMs);
    if (plainHtml && !looksLikeBlockedResponse(plainHtml)) {
      return { html: plainHtml, source: 'live' };
    }
  }

  const browserTimeout = Math.max(timeoutMs * 2.5, 25000);
  const rendered = await fetchHtmlWithBrowser(url, { timeoutMs: browserTimeout, brandId });
  if (rendered.html && !looksLikeBlockedResponse(rendered.html)) {
    return { html: rendered.html, source: 'live-browser' };
  }

  // Isınma (ana sayfayı gezip bot-koruma çerezlerini toplama) artık
  // varsayılan yolda değil — mutlu senaryoya 1,3-1,8sn ekliyor ve ölçümde
  // hiçbir markada ilk denemeyi kurtarmıyordu. Ama ilk deneme sessizce
  // (engel sayfası/boş içerik) başarısız olduysa denemeye değer. Sunucu
  // açıkça 4xx/5xx döndüyse (hardBlocked) atlıyoruz: aynı IP'den ikinci bir
  // deneme de reddedilecek, sadece kullanıcıyı bekletir.
  if (!rendered.hardBlocked) {
    const warmed = await fetchHtmlWithBrowser(url, { timeoutMs: browserTimeout, brandId, warmUp: true });
    if (warmed.html && !looksLikeBlockedResponse(warmed.html)) {
      return { html: warmed.html, source: 'live-browser-warmed' };
    }
  }

  if (ALLOW_FIXTURE_FALLBACK) {
    const fixturePath = DEV_FIXTURES[normalizeForFixtureLookup(url)];
    if (fixturePath && fs.existsSync(fixturePath)) {
      return { html: fs.readFileSync(fixturePath, 'utf8'), source: 'dev-fixture' };
    }
  }

  return null;
}

module.exports = { fetchHtml, looksLikeBlockedResponse };
