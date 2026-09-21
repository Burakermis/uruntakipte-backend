const { detectBrand, resolveProductFromHtml } = require('./scraper/registry');
const { fetchHtml } = require('./scraper/fetchHtml');
const trackedTargetStore = require('./store/trackedTargetStore');
const subscriptionStore = require('./store/subscriptionStore');
const priceHistoryStore = require('./store/priceHistoryStore');
const deviceTokenStore = require('./store/deviceTokenStore');
const { sendExpoPush } = require('./notifications/expoPush');
const { NOT_CURRENTLY_PURCHASABLE } = require('./constants');

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
    await trackedTargetStore.update(target.id, {
      consecutiveFailures: target.consecutiveFailures + 1,
      lastCheckStatus: 'UNSUPPORTED',
      lastAttemptAt: new Date().toISOString(),
    });
    return { id: target.id, ok: false, reason: 'UNSUPPORTED' };
  }

  const fetched = await fetchHtml(target.url, { brandId: brand.id });
  if (!fetched) {
    await trackedTargetStore.update(target.id, {
      consecutiveFailures: target.consecutiveFailures + 1,
      lastCheckStatus: 'FETCH_FAILED',
      lastAttemptAt: new Date().toISOString(),
    });
    return { id: target.id, ok: false, reason: 'FETCH_FAILED' };
  }

  const resolved = resolveProductFromHtml({ url: target.url, html: fetched.html });
  if (resolved.error) {
    await trackedTargetStore.update(target.id, {
      consecutiveFailures: target.consecutiveFailures + 1,
      lastCheckStatus: resolved.error,
      lastAttemptAt: new Date().toISOString(),
    });
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
  const tokens = (await deviceTokenStore.listByUser(subscription.userId)).map((t) => t.expoPushToken);
  if (tokens.length === 0) return { sent: 0, reason: 'NO_DEVICE' };

  const title =
    event.type === 'price_drop' ? `${target.name} fiyatı düştü` : `${target.name} stoğa girdi`;
  const body =
    event.type === 'price_drop'
      ? `${event.previousPrice} → ${event.newPrice} ${event.currency ?? ''}`.trim()
      : `${variant.color} / ${variant.size} tekrar satışta`;

  return sendExpoPush(tokens, {
    title,
    body,
    data: { subscriptionId: subscription.id, type: event.type, url: target.canonicalUrl },
  });
}

module.exports = { checkTrackedTarget };
