const logger = require('../logger');
const userStore = require('../store/userStore');
const subscriptionStore = require('../store/subscriptionStore');
const { limitsForTier } = require('../constants');
const { maskId } = require('../middleware/requestLog');
const { notifyUser } = require('../notifications/notifyUser');

// Premium biterken ücretsiz planın ürün sınırını UYGULAR. Bayrağı düşürmek yetmez: premium'dayken 100 ürün ekleyip
// süreyi bitiren kullanıcı, yeni ekleme engellense bile mevcut 100 ürünü ücretsiz takip etmeye devam ederdi.
//
// Hangi ürünler kalır? En eski takibe alınan `maxActiveProducts` ürün (kullanıcının "ilk seçtikleri"); fazlası pasifleşir.
// removed_at YAZILMAZ: bu kullanıcının kendi kararı değil, "çıkardıktan sonra 48 saat bekle" kuralını tetiklememeli.
// İdempotent: limit aşılmıyorsa hiçbir şey yapmaz — aynı olay yeniden iletilse de, uzlaştırma tekrar çalışsa da güvenli.
async function enforceFreeLimit(userId) {
  const max = limitsForTier(false).maxActiveProducts;
  const removedTargets = await subscriptionStore.withUserLock(userId, async (tx) => {
    const targets = await subscriptionStore.listActiveTargetIdsOldestFirst(userId, tx);
    const excess = targets.slice(max);
    if (excess.length > 0) await subscriptionStore.deactivateTargets(userId, excess, tx);
    return excess;
  });
  if (removedTargets.length === 0) return { removed: 0 };

  logger.info({ userId: maskId(userId), removed: removedTargets.length, kept: max }, '[plan] premium bitti, ürün sınırı uygulandı');
  try {
    await notifyUser({
      userId,
      type: 'plan_downgraded',
      title: 'Premium planın sona erdi',
      body: `Ücretsiz planda ${max} ürün takip edilebiliyor. İlk eklediğin ${max} ürün takipte kaldı, diğer ${removedTargets.length} ürün takip listenden çıkarıldı.`,
    });
  } catch (err) {
    logger.warn({ err: err.message }, '[plan] plan değişikliği bildirimi gönderilemedi');
  }
  return { removed: removedTargets.length };
}

// Premium durumunun TEK giriş noktası (webhook, sync-premium, uzlaştırma, geliştirme ucu). eventAtMs verilirse eski
// bir olay daha yeni bir durumu ezmez (bkz. userStore.applyPremiumState). Sonuç ücretsizse limit uygulanır; bu yalnızca
// "premium -> ücretsiz" geçişinde değil, uygulanan HER ücretsiz durumda çalışır, böylece olay yeniden iletilirse ya da
// önceki bir uygulama yarıda kesildiyse eksik kalan temizlik tamamlanır.
async function setPlan(userId, premium, { eventAtMs = null } = {}) {
  const result = await userStore.applyPremiumState(userId, premium, { eventAtMs });
  if (result.applied && !result.current) {
    const { removed } = await enforceFreeLimit(userId);
    return { ...result, removed };
  }
  return { ...result, removed: 0 };
}

module.exports = { setPlan, enforceFreeLimit };
