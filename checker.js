const { detectBrand, resolveProductFromHtml } = require('./scraper/registry');
const { fetchHtml } = require('./scraper/fetchHtml');
const trackedTargetStore = require('./store/trackedTargetStore');
const subscriptionStore = require('./store/subscriptionStore');
const priceHistoryStore = require('./store/priceHistoryStore');
const logger = require('./logger');
const { notifyUser } = require('./notifications/notifyUser');
const { NOT_CURRENTLY_PURCHASABLE, FAILURE_NOTIFY_THRESHOLD } = require('./constants');
const { decideGone } = require('./goneDecision');
const { captureMessage } = require('./monitoring/sentry');

// Marka şalteri tetiklenince her hedef için ayrı uyarı yağmasın: marka başına en fazla saatte bir Sentry mesajı.
const HOLD_ALERT_INTERVAL_MS = 60 * 60 * 1000;
const lastHoldAlertAt = new Map();

function alertHeldBrand(brand, context) {
  const now = Date.now();
  if (now - (lastHoldAlertAt.get(brand) || 0) < HOLD_ALERT_INTERVAL_MS) return;
  lastHoldAlertAt.set(brand, now);
  captureMessage(`[checker] ${brand}: hedeflerin büyük kısmı aynı anda 404 veriyor, abonelikler kapatılmıyor (site sorunu?)`, 'error', context);
}

// Ürün sayfası yok (404/410 ya da "Sayfa Bulunamadı") görüldü. Tek bir 404 abonelikleri KAPATMAZ: kesintisiz bir 404
// serisi izlenir ve karar goneDecision.js'te verilir (yeterli kontrol + süre, marka şalteri). Seri yalnızca başarılı
// bir kontrolle sıfırlanır; arada engel/zaman aşımı gelirse seri sürer. Hata sayacı (consecutiveFailures) ARTMAZ,
// kontrol normal sıklıkta devam eder.
async function handleProductGone(target, status) {
  const now = Date.now();
  const firstSeenAt = target.notFoundSince ? new Date(target.notFoundSince).getTime() : now;
  const count = target.notFoundCount + 1;
  await trackedTargetStore.update(target.id, {
    notFoundSince: new Date(firstSeenAt).toISOString(),
    notFoundCount: count,
    lastCheckStatus: 'NOT_FOUND',
    lastAttemptAt: new Date(now).toISOString(),
  });

  const decision = await decideGone({ status, count, firstSeenAt, now }, () => trackedTargetStore.notFoundStatsByBrand(target.brand));
  if (decision === 'remove') return removeGoneTarget(target, status);

  if (decision === 'hold') {
    logger.warn({ targetId: target.id, brand: target.brand, count }, '[checker] 404 serisi var ama marka genelinde sorun görünüyor, abonelikler korunuyor');
    alertHeldBrand(target.brand, { targetId: target.id, count });
  }
  return { id: target.id, ok: false, reason: 'NOT_FOUND', pending: decision };
}

// Aboneliklerin kapatılması: removed_at YAZILMAZ — bu kullanıcının kendi kararı değil, ücretsiz plandaki "çıkardıktan
// sonra 48 saat bekle" kuralını tetiklememeli.
async function removeGoneTarget(target, status) {
  await trackedTargetStore.update(target.id, { active: false, notFoundSince: null, notFoundCount: 0 });
  const subscriptions = await subscriptionStore.listByTarget(target.id);
  for (const sub of subscriptions) {
    await subscriptionStore.update(sub.id, { active: false });
    try {
      await sendNotificationForEvent(sub, target, null, { type: 'product_removed' });
    } catch (err) {
      logger.warn({ err: err.message, targetId: target.id }, '[checker] "ürün kaldırıldı" bildirimi gönderilemedi');
    }
  }
  logger.warn(
    { targetId: target.id, brand: target.brand, status, users: subscriptions.length },
    '[checker] ürün sayfası yok, takip sonlandırıldı'
  );
  return { id: target.id, ok: false, reason: 'NOT_FOUND', removedSubscriptions: subscriptions.length };
}

// Başarısız taramayı kaydeder; ardışık hata eşiğe (FAILURE_NOTIFY_THRESHOLD) ilk kez ulaşınca bu ürünü takip
// eden her kullanıcıya BİR KEZ "takip edilemiyor" bildirimi gönderir (ürün kaldırılmış / sayfa değişmiş / engellenmiş
// olabilir). Bildirim hatası taramayı etkilemez.
async function recordFailure(target, status) {
  const failures = target.consecutiveFailures + 1;
  const patch = { consecutiveFailures: failures, lastCheckStatus: status, lastAttemptAt: new Date().toISOString() };
  const shouldNotify = failures >= FAILURE_NOTIFY_THRESHOLD && !target.failureNotifiedAt;
  if (shouldNotify) patch.failureNotifiedAt = new Date().toISOString();
  await trackedTargetStore.update(target.id, patch);
  if (!shouldNotify) return;
  try {
    const subscriptions = await subscriptionStore.listByTarget(target.id);
    for (const sub of subscriptions) {
      await sendNotificationForEvent(sub, target, null, { type: 'tracking_failed' });
    }
    logger.warn(
      { targetId: target.id, brand: target.brand, status, users: subscriptions.length },
      '[checker] hedef kalıcı olarak taranamıyor, aboneler uyarıldı'
    );
  } catch (err) {
    logger.warn({ err: err.message, targetId: target.id }, '[checker] "takip edilemiyor" bildirimi gönderilemedi');
  }
}

/**
 * Tek bir HEDEFİ yeniden tarar: sayfayı BİR KEZ çeker, tüm varyantları
 * (renk×beden) hedefe yazar, fiyat geçmişine BİR KEZ kaydeder — sonra bu
 * hedefe abone olan HER kullanıcı için, kendi son gördüğü fiyat/duruma göre
 * (subscription.lastNotifiedPrice/lastNotifiedAvailability) ayrı ayrı karar
 * verip gerekirse bildirim yollar. Böylece aynı ürünü izleyen N kullanıcı
 * için ağa/siteye TEK istek gider (worker.js ve "şimdi kontrol et" endpoint'i
 * bunu kullanır), ama her kullanıcı kendi bildirim tercihine ve kendi
 * "ne zaman takibe başladığına" göre doğru bildirimi alır.
 */
async function checkTrackedTarget(target) {
  const brand = detectBrand(target.url);
  if (!brand) {
    await recordFailure(target, 'UNSUPPORTED');
    return { id: target.id, ok: false, reason: 'UNSUPPORTED' };
  }

  const fetched = await fetchHtml(target.url, { brandId: brand.id });
  if (fetched?.notFound) return handleProductGone(target, fetched.status);
  if (!fetched) {
    await recordFailure(target, 'FETCH_FAILED');
    return { id: target.id, ok: false, reason: 'FETCH_FAILED' };
  }

  const resolved = resolveProductFromHtml({ url: target.url, html: fetched.html });
  if (resolved.error) {
    await recordFailure(target, resolved.error);
    return { id: target.id, ok: false, reason: resolved.error };
  }

  await trackedTargetStore.update(target.id, {
    name: resolved.name,
    imageUrl: resolved.imageUrl,
    canonicalUrl: resolved.canonicalUrl,
    variants: resolved.variants,
    lastCheckedAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastCheckStatus: 'ok',
    consecutiveFailures: 0,
    failureNotifiedAt: null, // düzeldi: yeniden bozulursa tekrar uyarılabilir
    notFoundSince: null, // 404 serisi bozuldu: sayfa var
    notFoundCount: 0,
  });

  // Fiyat geçmişi HEDEF bazında (kullanıcı sayısından bağımsız) ve SADECE
  // DEĞİŞİKLİKTE yazılır: bir önceki başarılı kontrolde saklanan varyantla
  // (target.variants, yukarıdaki update'ten ÖNCEKİ hâli) fiyat ya da stok
  // durumu farklıysa, ya da varyant yeniyse. Eskiden her kontrol her
  // varyant için satır yazıyordu: 12 varyantlı premium bir hedef günde
  // ~17.000 satır, 100 premium hedef 90 günde ~18 GB, 1000 hedef ~175 GB
  // (bkz. perf/bench-history.js). "Sıkıcı" satırlar zaten 90 gün sonra
  // budanıyordu (bkz. priceHistoryStore.pruneUnchanged) — yazmadan atmak aynı
  // bilgiyi korur. Son kontrol zamanı history'den değil target.last_checked_at'ten.
  const previousBySku = new Map((target.variants || []).map((v) => [v.sku, v]));
  const changed = resolved.variants.filter((variant) => {
    const before = previousBySku.get(variant.sku);
    return !before || before.price !== variant.price || before.availability !== variant.availability;
  });
  await priceHistoryStore.recordMany(target.id, changed);

  const events = [];
  const subscriptions = await subscriptionStore.listByTarget(target.id);

  for (const sub of subscriptions) {
    const variant = resolved.variants.find((v) => v.sku === sub.sku);
    if (!variant) {
      // Bu renk/beden kombinasyonu siteden kaldırılmış olabilir — kullanıcının
      // abonelik kaydı kalır ama karşılaştıracak güncel veri yok, atla.
      continue;
    }

    const priceDropped =
      sub.lastNotifiedPrice != null && variant.price != null && variant.price < sub.lastNotifiedPrice;
    const cameBackInStock =
      NOT_CURRENTLY_PURCHASABLE.has(sub.lastNotifiedAvailability) &&
      !NOT_CURRENTLY_PURCHASABLE.has(variant.availability);

    const subEvents = [];
    if (priceDropped && sub.notifyOnPriceDrop) {
      subEvents.push({
        type: 'price_drop',
        previousPrice: sub.lastNotifiedPrice,
        newPrice: variant.price,
        currency: variant.currency,
      });
    }
    if (cameBackInStock && sub.notifyOnBackInStock) {
      subEvents.push({ type: 'back_in_stock' });
    }

    for (const event of subEvents) {
      await sendNotificationForEvent(sub, target, variant, event);
      events.push({ ...event, userId: sub.userId, subscriptionId: sub.id });
    }

    // Bildirim gitsin gitmesin, kullanıcının "son gördüğü" değeri güncel
    // tutuyoruz — tercih kapalıyken bile baseline güncel kalsın ki daha
    // sonra açıldığında eski bir farktan dolayı yanlış bildirim gitmesin.
    await subscriptionStore.update(sub.id, {
      lastNotifiedPrice: variant.price,
      lastNotifiedAvailability: variant.availability,
    });
  }

  return { id: target.id, ok: true, events };
}

async function sendNotificationForEvent(subscription, target, variant, event) {
  let title;
  let body;
  if (event.type === 'product_removed') {
    title = `${target.name || 'Ürün'} artık satışta değil`;
    body = 'Mağaza sayfası bulunamadı; ürün kaldırılmış olabilir. Takip listenden çıkardık.';
  } else if (event.type === 'tracking_failed') {
    title = `${target.name || 'Ürün'} takip edilemiyor`;
    body = 'Mağaza sayfasına bir süredir ulaşamıyoruz. Ürün kaldırılmış ya da sayfa değişmiş olabilir; düzelirse takip kendiliğinden devam eder.';
  } else if (event.type === 'price_drop') {
    title = `${target.name} fiyatı düştü`;
    body = `${event.previousPrice} → ${event.newPrice} ${event.currency ?? ''}`.trim();
  } else {
    title = `${target.name} stoğa girdi`;
    body = `${variant.color} / ${variant.size} tekrar satışta`;
  }

  // Geçmişe yazma + cihazlara push tek yerde (bkz. notifications/notifyUser.js).
  return notifyUser({
    userId: subscription.userId,
    type: event.type,
    title,
    body,
    productUrl: target.canonicalUrl,
    productName: target.name,
    imageUrl: target.imageUrl,
    data: { subscriptionId: subscription.id },
  });
}

module.exports = { checkTrackedTarget };
