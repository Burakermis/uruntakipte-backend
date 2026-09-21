const express = require('express');
const { detectBrand, resolveProductFromHtml, BRANDS } = require('../scraper/registry');
const { fetchHtml } = require('../scraper/fetchHtml');
const { normalizeTrackingUrl } = require('../scraper/normalizeUrl');
const { checkTrackedTarget } = require('../checker');
const trackedTargetStore = require('../store/trackedTargetStore');
const subscriptionStore = require('../store/subscriptionStore');
const priceHistoryStore = require('../store/priceHistoryStore');
const userStore = require('../store/userStore');
const htmlCache = require('../store/htmlCache');
const { scrapeQueue, scrapeQueueEvents } = require('../queue/scrapeQueue');
const { NOT_CURRENTLY_PURCHASABLE, limitsForTier, SCRAPE_JOB_TIMEOUT_MS } = require('../constants');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// İstemcinin KENDİ çektiği HTML'i gönderebilmesi (sunucunun engellendiği
// markalar için düşünülmüş, geliştirme/test akışı) VARSAYILAN OLARAK KAPALI:
// bu HTML'e güvenmek, herkesin paylaştığı bir hedefi (trackedTarget) ve
// Redis önbelleğini istemcinin yazdığı içerikle doldurmak demek. Canlı testte
// bir saldırgan gerçek bir ürün URL'i için sahte ad/fiyat/görsel içeren HTML
// gönderdi; o ürünü HTML'siz takibe alan başka bir kullanıcı sahte veriyi aldı
// (ad push bildirimi başlığına da giriyor). Mobil uygulama zaten hiç html
// göndermiyor ve sunucu artık 8 markanın hepsini kendisi çekebiliyor. Açmak
// için: ALLOW_CLIENT_HTML=1 (yalnızca yerel geliştirme). İstek zamanında
// okunuyor ki testler açıp kapatabilsin.
function clientHtmlAllowed() {
  return process.env.ALLOW_CLIENT_HTML === '1';
}

// POST /api/products/resolve
// Mobil uygulamanın "Ürün Ekle" ekranını doldurmak için çağırdığı endpoint.
// Henüz hiçbir şey kaydetmez — sadece URL'i çözüp renk/beden/fiyat/stok döner.
router.post('/resolve', asyncHandler(async (req, res) => {
  const { url } = req.body || {};
  const html = clientHtmlAllowed() ? (req.body || {}).html : undefined;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'url alanı zorunlu.' });
  }

  const brand = detectBrand(url);
  if (!brand) {
    return res.status(422).json({
      error: 'UNSUPPORTED_SITE',
      message: 'Bu site şu an desteklenmiyor. Desteklenen mağazalar: ' +
        BRANDS.map((b) => b.label).join(', '),
    });
  }

  let resolvedHtml = html;
  let htmlSource = 'client';

  if (!resolvedHtml) {
    const fetched = await fetchHtml(url, { brandId: brand.id });
    if (!fetched) {
      return res.status(502).json({
        error: 'FETCH_FAILED',
        message: 'Ürün sayfasına ulaşılamadı, lütfen daha sonra tekrar deneyin.',
      });
    }
    resolvedHtml = fetched.html;
    htmlSource = fetched.source;
  }

  const result = resolveProductFromHtml({ url, html: resolvedHtml });
  if (result.error) {
    const status = result.error === 'PARSE_FAILED' ? 422 : 500;
    return res.status(status).json(result);
  }

  // Çekilen HTML SUNUCUDA kalıyor: "Takibe Al" birkaç saniye sonra aynı
  // sayfanın verisine ihtiyaç duyduğunda worker bunu Redis'ten alıp sayfayı
  // ikinci kez taramaktan kurtuluyor (bkz. store/htmlCache.js,
  // queue/worker-process.js). Eskiden bu HTML yanıtla TELEFONA gönderilip
  // "Takibe Al"da geri yükleniyordu — ölçümde yanıtın 1027 KB'ının 1009 KB'ı
  // buydu, işe yarayan veri ise 3 KB.
  await htmlCache.put([normalizeTrackingUrl(url), normalizeTrackingUrl(result.canonicalUrl || url)], resolvedHtml);

  return res.json({ ...result, htmlSource });
}));

// Verilen URL için bir trackedTarget bulur ya da (ilk kez görülüyorsa)
// sayfayı çekip oluşturur. Aynı gerçek sayfa farklı ham URL'lerle işaret
// edilebildiği için (bkz. scraper/normalizeUrl.js) İKİ aşamalı arar:
//   1) ham URL'in normalize anahtarıyla (fetch'siz, hızlı yol)
//   2) bulunamazsa fetch edip adaptörün belirlediği canonicalUrl'in
//      anahtarıyla (bazı markalarda -Massimo Dutti gibi- ham URL'den
//      TAMAMEN farklı olabiliyor) — böylece aynı hedefe farklı sorgu
//      parametreleriyle gelen istekler gereksiz yere ikinci bir hedef
//      yaratmaz; ham anahtar da mevcut hedefe alias olarak eklenir ki bir
//      sonraki istek fetch'siz bulsun.
async function findOrCreateTarget({ url, brand, htmlOverride }) {
  const urlKey = normalizeTrackingUrl(url);
  let target = await trackedTargetStore.findByKey(urlKey);
  if (target) return { target, error: null };

  // İlk kez görülen URL — sayfa çekimi + trackedTarget oluşturma bu API
  // process'inde DEĞİL, ayrı bir worker process'te (queue/worker-process.js)
  // yapılıyor; BullMQ'nun concurrency sınırı orada uygulanıyor, birden fazla
  // kullanıcı aynı anda yeni ürün eklerse sunucu onlarca Chromium örneği
  // açıp tıkanmıyor. İstek yine de job tamamlanana kadar bekleyip aynı
  // response cycle'ında sonuçlanır (mobil tarafta değişiklik gerekmiyor).
  const job = await scrapeQueue.add('resolve-target', { url, brandId: brand.id, htmlOverride, urlKey });

  let result;
  try {
    result = await job.waitUntilFinished(scrapeQueueEvents, SCRAPE_JOB_TIMEOUT_MS);
  } catch {
    return {
      target: null,
      error: {
        status: 502,
        body: { error: 'FETCH_FAILED', message: 'Ürün sayfasına ulaşılamadı, lütfen daha sonra tekrar deneyin.' },
      },
    };
  }

  if (result.error) return { target: null, error: result.error };

  target = await trackedTargetStore.findById(result.targetId);
  return { target, error: null };
}

// Bir subscription + o subscription'ın işaret ettiği hedef/varyantı, mobil
// istemcinin beklediği düz TrackedProduct biçimine dönüştürür (API sözleşmesi
// eski tekli-tablo şemasıyla aynı kalsın diye — mobil tarafta değişiklik
// gerekmiyor).
// previous: bir önceki (farklı) fiyat ya da null — çağıran hesaplayıp verir ki
// liste ucu bunu abonelik başına ayrı sorgu yerine TOPLU çekebilsin.
function toApiShape(subscription, target, variant, previous) {
  const priceChangePercent =
    previous != null && variant.price != null && previous !== 0
      ? Math.round(((variant.price - previous) / previous) * 100)
      : null;

  return {
    id: subscription.id,
    userId: subscription.userId,
    brand: target.brand,
    productId: target.productId,
    name: target.name,
    imageUrl: target.imageUrl,
    canonicalUrl: target.canonicalUrl,
    color: variant.color,
    size: variant.size,
    sku: subscription.sku,
    lastPrice: variant.price,
    currency: variant.currency,
    lastAvailability: variant.availability,
    notifyOnPriceDrop: subscription.notifyOnPriceDrop,
    notifyOnBackInStock: subscription.notifyOnBackInStock,
    createdAt: subscription.createdAt,
    lastCheckedAt: target.lastCheckedAt,
    priceChangePercent,
  };
}

// POST /api/products
// Kullanıcı "Takibe Al" dediğinde çağrılır. Aynı ürünü (aynı hedef) başka bir
// kullanıcı zaten izliyorsa YENİ bir sayfa çekimi yapılmaz — mevcut hedefe
// yeni bir abonelik (subscription) eklenir. Aynı kullanıcı aynı renk/bedeni
// tekrar eklerse (daha önce silmişse) tercihleri güncellenip yeniden aktive
// edilir, mükerrer kayıt oluşmaz.
router.post('/', asyncHandler(async (req, res) => {
  const { userId, url, sku } = req.body || {};
  const html = clientHtmlAllowed() ? (req.body || {}).html : undefined;

  const required = { userId, url, sku };
  const missing = Object.entries(required)
    .filter(([, v]) => v == null || v === '')
    .map(([k]) => k);
  if (missing.length) {
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      message: `Eksik alan(lar): ${missing.join(', ')}`,
    });
  }

  const brand = detectBrand(url);
  if (!brand) {
    return res.status(422).json({
      error: 'UNSUPPORTED_SITE',
      message: 'Bu site şu an desteklenmiyor. Desteklenen mağazalar: ' +
        BRANDS.map((b) => b.label).join(', '),
    });
  }

  const { target, error } = await findOrCreateTarget({ url, brand, htmlOverride: html });
  if (error) return res.status(error.status).json(error.body);

  const variant = target.variants.find((v) => v.sku === sku);
  if (!variant) {
    return res.status(422).json({
      error: 'VARIANT_NOT_FOUND',
      message: 'Seçilen renk/beden artık mevcut değil.',
    });
  }

  // Her iki bildirim tercihi de İSTEMCİDEN gelmez, satın alınabilirlik
  // durumundan türetilir — ikisini birden kapatıp hiçbir bildirim almayan bir
  // abonelik yaratmak anlamsız olurdu. Satın alınabiliyorsa (in_stock/
  // low_stock) tek anlamlı bildirim fiyat düşüşüdür; satın ALINAMIYORSA
  // (out_of_stock/coming_soon) hem fiyat hem stok bildirimi anlamlı, ikisi de
  // açılır (bkz. mobile ProductVariantScreen.tsx — aynı kural orada UI'ı
  // kilitliyor, burası tek gerçek kaynak olarak zorunlu kılıyor).
  const notCurrentlyPurchasable = NOT_CURRENTLY_PURCHASABLE.has(variant.availability);
  const patch = {
    active: true,
    notifyOnPriceDrop: true,
    notifyOnBackInStock: notCurrentlyPurchasable,
    // Bu kullanıcının "başlangıç" değeri — bir sonraki kontrolde bundan
    // FARKLI bir fiyat/durum görülürse bildirim tetiklenir (bkz. checker.js).
    lastNotifiedPrice: variant.price,
    lastNotifiedAvailability: variant.availability,
  };

  const existing = await subscriptionStore.findByUserTargetSku(userId, target.id, sku);
  // Kullanıcı bu renk/bedeni ZATEN aktif olarak takip ediyorsa (silmemişse)
  // bu bir tekrar-ekleme denemesidir — mobil taraf bunu görüp farklı bir
  // mesaj gösterebilsin diye ayrı bir alanda işaretliyoruz. Daha önce silinip
  // şimdi yeniden eklenen (existing var ama active:false) gerçek bir yeni
  // ekleme sayılır, "zaten takipte" değildir.
  const alreadyTracked = !!existing?.active;

  // Bu SKU'dan bağımsız olarak: kullanıcının bu HEDEF (ürün) için zaten
  // aktif bir aboneliği var mı? Aynı ürünün farklı bir bedenini eklemek
  // (ör. S zaten takipteyken M'yi de eklemek) yeni bir "slot" tüketmemeli —
  // limit ürün bazlı, sku bazlı değil (bkz. store/subscriptionStore.js
  // countActiveByUser'ın artık DISTINCT target_id sayması).
  const hasProductSlot = alreadyTracked || (await subscriptionStore.hasActiveSubscriptionForTarget(userId, target.id));

  // Bu ürün için zaten bir slot varsa (aynı sku ya da aynı ürünün başka bir
  // bedeni) plan limiti/bekleme kuralı uygulanmaz.
  if (!hasProductSlot) {
    const isPremium = await userStore.isPremium(userId);
    const limits = limitsForTier(isPremium);

    const activeCount = await subscriptionStore.countActiveByUser(userId);
    if (activeCount >= limits.maxActiveProducts) {
      return res.status(403).json({
        error: 'PREMIUM_LIMIT_REACHED',
        message: `Ücretsiz planda en fazla ${limits.maxActiveProducts} ürün takip edebilirsin. Daha fazlası için Premium'a geç.`,
      });
    }

    if (limits.reAddCooldownMs > 0) {
      const lastRemoval = await subscriptionStore.lastRemovalAt(userId);
      const remainingMs = lastRemoval
        ? limits.reAddCooldownMs - (Date.now() - new Date(lastRemoval).getTime())
        : 0;
      if (remainingMs > 0) {
        return res.status(429).json({
          error: 'PREMIUM_COOLDOWN_ACTIVE',
          message:
            `Bir ürünü çıkardıktan sonra yeni ürün eklemek için ${Math.ceil(remainingMs / (60 * 60 * 1000))} saat daha beklemen gerekiyor. Premium'da bu bekleme yok.`,
          cooldownRemainingMs: remainingMs,
        });
      }
    }
  }

  const subscription = existing
    ? await subscriptionStore.update(existing.id, patch)
    : await subscriptionStore.create({ userId, targetId: target.id, sku, ...patch });

  // Hedef daha önce (son abonesi silindiği için) pasifleşmiş olabilir —
  // yeniden abone olunca worker'ın tekrar taraması için aktive edilir.
  await trackedTargetStore.update(target.id, { active: true });

  const previous = await priceHistoryStore.previousPrice(target.id, subscription.sku, variant.price);
  const shaped = toApiShape(subscription, target, variant, previous);
  return res.status(201).json({ ...shaped, alreadyTracked });
}));

// GET /api/products?userId=...
// Her kayda, Ürünlerim listesindeki rozet için bir önceki kontrole göre
// fiyat değişim yüzdesini de ekler.
router.get('/', asyncHandler(async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'userId query param zorunlu.' });
  }

  // TOPLU: hedefler ve önceki fiyatlar abonelik başına ayrı sorgu yerine
  // toplam 3 sorguyla geliyor. Eskiden abonelik başına 2 sorgu vardı — 50 ürün
  // izleyen bir kullanıcının listesi 10 eşzamanlıda ~1sn, 200 ürünlüde ~3,7sn
  // sürüyordu ve DB havuzunu doldurup diğer kullanıcıları da bekletiyordu
  // (bkz. perf/bench-api.js).
  const subscriptions = await subscriptionStore.listByUser(userId);
  const targets = await trackedTargetStore.findByIds([...new Set(subscriptions.map((s) => s.targetId))]);

  const resolved = [];
  for (const sub of subscriptions) {
    const target = targets.get(sub.targetId);
    const variant = target?.variants.find((v) => v.sku === sub.sku);
    if (target && variant) resolved.push({ sub, target, variant });
  }
  const previous = await priceHistoryStore.previousPrices(
    resolved.map(({ sub, target, variant }) => ({ targetId: target.id, sku: sub.sku, currentPrice: variant.price }))
  );

  return res.json(
    resolved.map(({ sub, target, variant }) => toApiShape(sub, target, variant, previous.get(`${target.id}|${sub.sku}`) ?? null))
  );
}));

// DELETE /api/products/:id?userId=... — takipten çıkar (sadece bu kullanıcının
// aboneliği silinir; ürünü izleyen başka kullanıcı varsa hedef taranmaya
// devam eder).
// id'ler SERIAL (1,2,3...) olduğu için tahmin edilmesi trivial — userId
// eşleşmesi zorunlu kılınmazsa herhangi biri başka bir kullanıcının takip
// kaydını silebilirdi (IDOR). Var olmayan/başkasına ait id aynı 404'ü
// döndürüyor ki hangisi olduğu dışarıdan ayırt edilemesin.
router.delete('/:id', asyncHandler(async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'userId query param zorunlu.' });
  }

  const sub = await subscriptionStore.findById(req.params.id);
  if (!sub || !sub.active || sub.userId !== userId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Takip kaydı bulunamadı.' });
  }
  await subscriptionStore.remove(sub.id);

  // Bu hedefe artık kimse abone değilse worker'ın boşuna taramaması için
  // pasifleştir (veri/geçmiş silinmez, biri tekrar abone olursa devam eder).
  if ((await subscriptionStore.countActiveByTarget(sub.targetId)) === 0) {
    await trackedTargetStore.update(sub.targetId, { active: false });
  }

  return res.status(204).send();
}));

// POST /api/products/:id/check-now — kullanıcı manuel olarak "şimdi kontrol
// et" dediğinde (örn. Ürünlerim ekranında aşağı çekip yenileme) worker'ın
// periyodik turunu beklemeden hedefi hemen yeniden tarar. Hedefi başka
// kullanıcılar da izliyorsa bu kontrol ONLARIN da verisini günceller —
// tek bir isteğin herkese fayda sağlaması amaçlanan davranış budur.
// userId eşleşmesi yine de zorunlu: bu ID senin aboneliğin OLMALI, aksi
// halde herhangi biri başkasının kaydını tetikleyip (ucuz olmayan bir
// scrape işlemini) israf ettirebilirdi (bkz. DELETE /:id'deki aynı gerekçe).
router.post('/:id/check-now', asyncHandler(async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'userId zorunlu.' });
  }

  const sub = await subscriptionStore.findById(req.params.id);
  if (!sub || !sub.active || sub.userId !== userId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Takip kaydı bulunamadı.' });
  }
  const target = await trackedTargetStore.findById(sub.targetId);
  if (!target) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Takip edilen ürün bulunamadı.' });
  }

  const result = await checkTrackedTarget(target);
  const updatedTarget = await trackedTargetStore.findById(target.id);
  const variant = updatedTarget?.variants.find((v) => v.sku === sub.sku);

  return res.json({
    id: sub.id,
    ok: result.ok,
    price: variant?.price ?? null,
    availability: variant?.availability ?? null,
    events: (result.events || []).filter((e) => e.subscriptionId === sub.id),
    reason: result.reason,
  });
}));

module.exports = router;
