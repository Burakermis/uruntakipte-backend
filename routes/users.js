const express = require('express');
const userStore = require('../store/userStore');
const subscriptionStore = require('../store/subscriptionStore');
const { limitsForTier } = require('../constants');
const logger = require('../logger');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v1';

// GET /api/users/:userId/limits
// Mobil "Ürün Ekle" ve "Ürünlerim" ekranlarının, kullanıcı bir işlem
// denemeden ÖNCE plan durumunu gösterebilmesi için (ör. "2/3 ürün
// kullanılıyor", ya da bekleme süresi varsa geri sayım).
router.get('/:userId/limits', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const isPremium = await userStore.isPremium(userId);
  const limits = limitsForTier(isPremium);
  const activeCount = await subscriptionStore.countActiveByUser(userId);

  const lastRemovalAt = isPremium ? null : await subscriptionStore.lastRemovalAt(userId);
  let cooldownRemainingMs = 0;
  if (lastRemovalAt) {
    const elapsed = Date.now() - new Date(lastRemovalAt).getTime();
    cooldownRemainingMs = Math.max(0, limits.reAddCooldownMs - elapsed);
  }

  return res.json({
    userId,
    isPremium,
    activeCount,
    maxActiveProducts: Number.isFinite(limits.maxActiveProducts) ? limits.maxActiveProducts : null,
    checkIntervalMs: limits.checkIntervalMs,
    cooldownRemainingMs,
  });
}));

// POST /api/users/:userId/premium
// DEV/DEMO amaçlı: gerçek bir App Store/Play Store IAP entegrasyonu yerine
// geçiyor (o, ayrı bir geliştirici hesabı + billing altyapısı gerektiriyor,
// şu anki kapsamın dışında). NODE_ENV=production'da kapalı — açık kalsaydı
// herhangi biri kendini bedavaya premium yapabilirdi (bkz.
// scraper/fetchHtml.js'deki ALLOW_FIXTURE_FALLBACK ile aynı gating deseni).
// Gerçek/native satın alma sonrası mobil taraf artık bunun yerine aşağıdaki
// POST /:userId/sync-premium'u çağırıyor (bkz. PremiumScreen.tsx) — prod'da
// premium durumunun asıl kaynağı SADECE routes/webhooks.js'deki RevenueCat
// webhook'u ve bu sync uç noktasıdır, ikisi de istemcinin kendi beyanına
// değil RevenueCat'in doğruladığı veriye dayanır.
router.post('/:userId/premium', asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      error: 'DEV_ONLY_ENDPOINT',
      message: 'Bu uç nokta sadece geliştirme ortamında kullanılabilir.',
    });
  }

  const { userId } = req.params;
  const { isPremium } = req.body || {};
  if (typeof isPremium !== 'boolean') {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'isPremium (boolean) zorunlu.' });
  }
  const record = await userStore.setPremium(userId, isPremium);
  return res.json({ userId: record.userId, isPremium: record.isPremium });
}));

// POST /api/users/:userId/sync-premium
// Native satın alma/geri yükleme SONRASI mobil tarafın çağırdığı, prod'da da
// AÇIK kalabilen güvenli senkron uç noktası — yukarıdaki /premium'un aksine
// istemcinin "premium yaptım" beyanına güvenmez; RevenueCat'in sunucu
// tarafı REST API'sinden bu userId (RevenueCat App User ID = deviceId, bkz.
// mobile/src/purchases.ts) için GERÇEKTEN aktif bir entitlement var mı diye
// sorup öyle günceller. routes/webhooks.js zaten asıl doğruluk kaynağı ama
// birkaç saniye gecikebiliyor (bkz. o dosyadaki yorum) — bu uç nokta satın
// alma/restore sonrası UI'ın DB'yi yanlış bir şeye ayarlama riski olmadan
// hemen doğru durumu göstermesini sağlıyor.
router.post('/:userId/sync-premium', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const secretKey = process.env.REVENUECAT_SECRET_KEY;
  if (!secretKey) {
    return res.status(503).json({
      error: 'NOT_CONFIGURED',
      message: 'RevenueCat sunucu entegrasyonu henüz yapılandırılmadı (REVENUECAT_SECRET_KEY eksik).',
    });
  }

  let subscriber;
  try {
    const rcRes = await fetch(`${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!rcRes.ok) {
      logger.error({ userId, status: rcRes.status }, '[users] RevenueCat subscriber sorgusu başarısız');
      return res.status(502).json({ error: 'REVENUECAT_ERROR', message: 'RevenueCat sorgulanamadı.' });
    }
    ({ subscriber } = await rcRes.json());
  } catch (err) {
    logger.error({ userId, err: err.message }, '[users] RevenueCat isteği atılamadı');
    return res.status(502).json({ error: 'REVENUECAT_ERROR', message: 'RevenueCat sorgulanamadı.' });
  }

  // RevenueCat'in REST API'si "entitlements" altında kullanıcının GELMİŞ
  // GEÇMİŞ tüm entitlement'larını döner (SDK'daki customerInfo.entitlements
  // .active gibi önceden filtrelenmiş değil) — aktif mi diye expires_date'i
  // kendimiz kontrol ediyoruz; null/undefined expires_date süresiz (ör.
  // lifetime) demek.
  const now = Date.now();
  const entitlements = subscriber?.entitlements || {};
  const isPremium = Object.values(entitlements).some(
    (e) => !e.expires_date || new Date(e.expires_date).getTime() > now
  );

  const record = await userStore.setPremium(userId, isPremium);
  return res.json({ userId: record.userId, isPremium: record.isPremium });
}));

module.exports = router;
