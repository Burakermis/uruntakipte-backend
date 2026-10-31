const logger = require('../logger');
const userStore = require('../store/userStore');
const { BILLING } = require('../constants');
const { maskId } = require('../middleware/requestLog');
const { fetchPremiumState } = require('./revenuecat');
const { setPlan } = require('./plan');

// Webhook birincil yoldur ama tek başına yetmez: RevenueCat olayı kaçabilir (kesinti, yanlış secret, silinmiş uç) ve
// sonuç, süresi dolmuş ya da iade edilmiş aboneliğin sonsuza kadar premium kalması olur. Bu iş, premium görünen
// kullanıcıları RevenueCat'in kendisine sorarak (BILLING.reconcileStaleMs'ten eski doğrulamaları) düzeltir. Otorite
// RevenueCat'tir; sonuç ücretsizse limit de uygulanır (bkz. billing/plan.js).
//
// RevenueCat sorgusu başarısız olursa kullanıcı değiştirilmez ve işaretlenmez: bir sonraki çalışmada yeniden denenir
// (kesinti premium kullanıcıyı yanlışlıkla düşürmez).
async function reconcilePremium({ limit = BILLING.reconcileBatch, staleMs = BILLING.reconcileStaleMs } = {}) {
  if (!process.env.REVENUECAT_SECRET_KEY) return { skipped: 'NOT_CONFIGURED' };

  const userIds = await userStore.listPremiumDueForCheck(limit, staleMs);
  const summary = { due: userIds.length, checked: 0, downgraded: 0, failed: 0 };
  for (const userId of userIds) {
    const state = await fetchPremiumState(userId);
    if (!state.ok) {
      summary.failed += 1;
      logger.warn({ userId: maskId(userId), reason: state.reason }, '[reconcile] RevenueCat sorgulanamadı, sonra tekrar denenecek');
      continue;
    }
    const result = await setPlan(userId, state.isPremium, { eventAtMs: Date.now() });
    await userStore.markPremiumChecked(userId);
    summary.checked += 1;
    if (result.applied && result.previous && !result.current) summary.downgraded += 1;
  }
  if (summary.downgraded > 0 || summary.failed > 0) logger.info(summary, '[reconcile] premium uzlaştırma tamamlandı');
  return summary;
}

module.exports = { reconcilePremium };
