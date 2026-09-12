const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const pLimit = require('p-limit');
const logger = require('../logger');
const { brandFetchProfile } = require('./registry');

// Elle yazılmış birkaç satırlık gizleme yerine, topluluğun onlarca bilinen
// headless-tespit sinyalini (navigator.webdriver, canvas/WebGL fingerprint,
// chrome.app, iframe.contentWindow, medya kodekleri, vb.) kapatan stealth
// eklentisi. Not: bu proje üzerinde test ettiğimiz Akamai korumalı siteler
// (Zara, H&M) isteği sayfa hiç yüklenmeden ağ/edge seviyesinde reddediyor —
// yani stealth'in çözebileceği sınıfın (tarayıcı parmak izi) ÖTESİNDE bir
// engel. Yine de daha az agresif korumalı siteler için gerçek fayda sağlar.
chromium.use(StealthPlugin());

let browserPromise = null;

// Queue kurulana kadar (Faz 2 roadmap) sunucunun aynı anda onlarca Chromium
// sekmesi açıp belleği/CPU'yu tüketmesini engelleyen ara adım — birden fazla
// kullanıcı aynı anda YENİ bir ürün eklerse istekler sırayla (en fazla 5
// tanesi paralel) işlenir, patlamaz.
const BROWSER_CONCURRENCY = 5;
const limit = pLimit(BROWSER_CONCURRENCY);

// Ürün verisi için hiçbirine ihtiyacımız yok — parse ettiğimiz her şey HTML'de.
// Görselleri/fontları/CSS'i indirmemek hem sayfayı hızlandırıyor hem de
// bant genişliğini (ve hedef sitenin yükünü) belirgin biçimde azaltıyor.
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

// Markanın `ready` koşulu için üst sınır. Koşul gerçekleşmezse sayfa yine de
// o anki hâliyle parse'a gider (bazı markalarda kısmi veri de işe yarar) —
// bu yüzden bu bir hata değil, sadece "daha fazla bekleme" sınırı.
const READY_TIMEOUT_MS = 12000;
const READY_POLL_MS = 100;
// Bu süreden sonra hâlâ "engel sayfası kadar küçük" bir belge varsa beklemeyi
// kes (bkz. waitForBrandReady). Gerçek ürün sayfaları saniyenin altında bu
// eşiğin çok üstüne çıkıyor (ölçümde en küçüğü ~300KB).
const BLOCK_GRACE_MS = 2000;
const BLOCKED_HTML_MAX_LENGTH = 5000;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

// Sunucu/worker açılışında çağrılır: ilk ürün ekleyen kullanıcı Chromium'un
// açılmasını (~0,2-1sn) beklemesin diye tarayıcıyı önden başlatır. Hata
// olursa sessizce geçiyoruz — ilk gerçek istekte tekrar denenir.
function prewarmBrowser() {
  return getBrowser().then(
    () => logger.info('[browserFetch] Chromium önden başlatıldı'),
    (err) => {
      browserPromise = null;
      logger.error({ err: err.message }, '[browserFetch] Chromium önden başlatılamadı');
    }
  );
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Akamai gibi korumalar aynı IP'den gelen art arda istekleri (stealth
// eklentisine rağmen) engelleyebiliyor — bir residential/datacenter proxy
// servisi (Bright Data, Oxylabs, Smartproxy vb.) tanımlıysa her context
// FARKLI bir proxy'den açılır (round-robin). PROXY_LIST tanımlı değilse
// (dev ortamı / henüz bir servis seçilmediyse) proxysiz, eski davranış
// aynen sürer — bu yüzden env eksikliği hata değil, sessiz no-op.
const PROXY_LIST = (process.env.PROXY_LIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let proxyIndex = 0;

// "http://user:pass@host:port" biçimindeki bir proxy URL'ini Playwright'ın
// beklediği {server, username, password} biçimine ayırır.
function nextProxy() {
  if (PROXY_LIST.length === 0) return undefined;
  const raw = PROXY_LIST[proxyIndex % PROXY_LIST.length];
  proxyIndex += 1;
  try {
    const parsed = new URL(raw);
    return {
      server: `${parsed.protocol}//${parsed.host}`,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
    };
  } catch (err) {
    logger.error({ err: err.message }, '[browserFetch] PROXY_LIST içinde geçersiz bir URL var, atlanıyor');
    return undefined;
  }
}

/**
 * Markanın parser'ının ihtiyaç duyduğu veri DOM'a gelene kadar bekler.
 *
 * İki incelik var:
 *  - Akamai interstitial'ı sayfayı kendi kendine yeniden yüklüyor; bu sırada
 *    JS bağlamı yok olup koşul "Execution context was destroyed" ile
 *    patlayabiliyor. Bu bir başarısızlık değil, geçici bir durum — kalan
 *    süre içinde yeni bağlamda tekrar deniyoruz.
 *  - Koşul hiç gerçekleşmezse hata FIRLATMIYORUZ: elimizdeki HTML yine de
 *    parse edilir, üst katman (fetchHtml) sonucu değerlendirir.
 */
async function waitForBrandReady(page, ready, brandId) {
  const start = Date.now();
  const deadline = start + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(ready)) return true;

      // Bot engeli sayfaları (H&M'in 322 baytlık "Access Denied"i gibi) HTTP
      // 200 dönebiliyor — status'a bakarak yakalanamıyorlar. Kısa bir
      // toleranstan sonra hâlâ birkaç yüz baytlık bir belge varsa, bu bir
      // ürün sayfası değil: 12sn boyunca beklemenin anlamı yok.
      if (Date.now() - start > BLOCK_GRACE_MS) {
        const htmlLength = await page.evaluate(() => document.documentElement.outerHTML.length);
        if (htmlLength < BLOCKED_HTML_MAX_LENGTH) {
          logger.warn({ brandId, htmlLength }, '[browserFetch] sayfa engel/ara sayfası gibi görünüyor, beklemeden çıkılıyor');
          return false;
        }
      }
    } catch (err) {
      // Bot-doğrulama yönlendirmesi JS bağlamını yok edebiliyor — bu bir
      // başarısızlık değil, yeni bağlamda yoklamaya devam.
      if (!/Execution context was destroyed|frame was detached|navigation|Target closed/i.test(err.message)) {
        logger.error({ brandId, err: err.message }, '[browserFetch] hazır-olma koşulu çalıştırılamadı');
        return false;
      }
    }
    await page.waitForTimeout(READY_POLL_MS).catch(() => {});
  }

  logger.warn({ brandId, url: page.url().slice(0, 120) }, '[browserFetch] marka hazır-olma koşulu gerçekleşmedi, eldeki HTML ile devam ediliyor');
  return false;
}

/**
 * Bir URL'i gerçek bir tarayıcıda açıp render edilmiş HTML'i döner.
 * @returns {Promise<{html: string|null, status: number|null, hardBlocked: boolean}>}
 *   hardBlocked: sunucu HTTP hata koduyla (403/429/5xx) reddetti — sayfanın
 *   render olmasını beklemenin ya da tekrar denemenin anlamı yok.
 */
function fetchHtmlWithBrowser(url, options) {
  return limit(() => fetchHtmlWithBrowserInner(url, options));
}

async function fetchHtmlWithBrowserInner(url, { timeoutMs = 25000, warmUp = false, brandId } = {}) {
  const profile = brandFetchProfile(brandId);
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: 'tr-TR',
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' },
      proxy: nextProxy(),
    });

    const page = await context.newPage();

    // Görsel/font/CSS/video indirmiyoruz — parse ettiğimiz veri HTML'de,
    // bunlar sadece süre ve bant genişliği. (Ölçüm: aynı sayfalar bu
    // engellemeyle de birebir aynı fiyat/beden/stok sonucunu veriyor.)
    // NOT: route geri çağrımından dönen promise'i YUTMAK zorundayız. Sayfa
    // kapanırken (ör. hedef 403 verip erken çıktığımızda) uçuşta kalan
    // isteklerin abort/continue çağrısı "Target page, context or browser has
    // been closed" ile reddediliyor; bu reddi kimse beklemediği için Node 21
    // altında YAKALANMAMIŞ PROMISE REDDİ olarak tüm worker process'ini
    // düşürüyordu — yani tek bir engellenmiş sayfa periyodik kontrollerin
    // TAMAMINI sessizce durduruyordu (canlı testte gerçekleşti).
    await page.route('**/*', async (route) => {
      try {
        if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) await route.abort();
        else await route.continue();
      } catch {
        // Sayfa/context kapanırken uçuşta kalan istekler — yapılacak bir şey
        // yok, önemli olan bu reddin dışarı SIZMAMASI.
      }
    });

    // Akamai Bot Manager gibi korumalar, doğrudan ürün sayfasına yapılan
    // "soğuk" tek seferlik istekleri şüpheli bulabiliyor — ısınma
    // navigasyonu sitenin sensör JS'ini çalıştırıp meşruiyet çerezlerini
    // (ak_bmsc, bm_sz, _abck) biriktiriyor. ARTIK VARSAYILAN DEĞİL: ölçümde
    // sekiz markanın hiçbirinde ilk denemeyi kurtarmadı, buna karşılık her
    // taramaya 1,3-1,8sn ekliyordu. Sadece ilk deneme engelli/boş dönerse
    // fetchHtml.js bunu ikinci kademe olarak açıyor.
    if (warmUp) {
      try {
        const origin = new URL(url).origin;
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForTimeout(500 + Math.random() * 300);
      } catch {
        // ısınma başarısız olsa da asıl isteği yine de dene
      }
    }

    // 'commit': ilk yanıt gelir gelmez devam et. 'domcontentloaded'ı
    // beklemek, sayfadaki onlarca üçüncü-parti script'in (consent, analitik,
    // öneri motoru) inmesini beklemek demekti — oysa bizim ihtiyacımız olan
    // veri çoğu markada çok daha erken hazır. Ne zaman devam edeceğimize
    // aşağıdaki marka-özel `ready` koşulu karar veriyor.
    const response = await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });

    // Sunucu doğrudan reddettiyse (H&M bu ağdan 403 "Access Denied" veriyor)
    // sayfanın render olmasını beklemek tamamen boşuna — eskiden burada
    // hazır-olma zaman aşımı kadar (12sn) bekleyip bir de ısınmalı ikinci
    // denemeyi yapıyorduk, tek bir ürün için ~27sn ediyordu. Artık ~1sn'de
    // pes edip üst katmana "sert engel" diyoruz.
    const status = response ? response.status() : null;
    if (status && status >= 400) {
      logger.warn({ url, status, brandId }, '[browserFetch] sunucu HTTP hata koduyla reddetti');
      return { html: null, status, hardBlocked: true };
    }

    // Sabit süre beklemek yerine, SADECE bu markanın parser'ının ihtiyaç
    // duyduğu veri DOM'a gelene kadar bekliyoruz (bkz. brands/*.js
    // fetchProfile.ready). Koşul gerçekleşmezse (site yapısı değiştiyse,
    // bot engeline takıldıysak) sayfa yine de o anki hâliyle parse'a gider.
    if (profile.ready) {
      await waitForBrandReady(page, profile.ready, brandId);
    }

    // Bazı siteler (örn. Pull&Bear) fiyat/beden gibi kritik veriyi Web
    // Component'lerin (<price-element>, <size-selector-with-length> gibi
    // custom element'ler) Shadow DOM'u içinde tutuyor. page.content() düz
    // HTML serialize eder ve Shadow DOM içeriğini GÖRMEZ — bu yüzden
    // page.content()'i almadan önce, her open shadow root'un içeriğini
    // kendi elementinin innerHTML'ine "düzleştirip" gömüyoruz ki cheerio
    // ile normal HTML gibi parse edilebilsin. (Closed shadow root'lar bu
    // yöntemle görülemez — nadir, encapsulation'ı bilinçli sıkılaştıran
    // siteler kullanır.) Sadece buna GERÇEKTEN ihtiyacı olan markada
    // çalışıyor (fetchProfile.flattenShadowDom) — tüm DOM'u dolaşan bir
    // işlem, diğer yedi markada boşuna maliyet.
    if (profile.flattenShadowDom) {
      await page.evaluate(() => {
        function flatten(root) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          const elements = [];
          let node = walker.currentNode;
          do {
            elements.push(node);
          } while ((node = walker.nextNode()));
          for (const el of elements) {
            if (el.shadowRoot) {
              flatten(el.shadowRoot);
              el.innerHTML = el.shadowRoot.innerHTML;
            }
          }
        }
        flatten(document.body);
      });
    }

    return { html: await page.content(), status, hardBlocked: false };
  } catch (err) {
    logger.error({ url, err: err.message }, '[browserFetch] sayfa açılamadı');
    return { html: null, status: null, hardBlocked: false };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    browserPromise = null;
    await browser.close().catch(() => {});
  }
}

module.exports = { fetchHtmlWithBrowser, closeBrowser, prewarmBrowser };
