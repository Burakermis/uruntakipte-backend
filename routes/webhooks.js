const crypto = require('crypto');
const express = require('express');
const userStore = require('../store/userStore');
const logger = require('../logger');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// RevenueCat, StoreKit/Play Billing'in gerçek satın alma makbuzunu ZATEN
// doğrulayıp bu webhook'u tetikliyor — burada tekrar bir makbuz doğrulaması
// YAPMIYORUZ, sadece "hangi deviceId'nin (RevenueCat App User ID = Faz 3'teki
// deviceId, bkz. mobile/src/purchases.ts) durumu ne oldu" bilgisini
// userStore.setPremium'a aktarıyoruz — imza (userId -> isPremium) dev-toggle
// ile birebir aynı kaldığı için routes/users.js'e dokunmaya gerek kalmadı.
const PREMIUM_ACTIVATING_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'NON_RENEWING_PURCHASE',
]);
const PREMIUM_DEACTIVATING_EVENTS = new Set(['EXPIRATION']);

function isAuthorized(req) {
  const expected = process.env.REVENUECAT_WEBHOOK_SECRET;
  // Secret tanımlanmadıysa (henüz RevenueCat hesabı kurulmadıysa) yalnızca
  // geliştirmede engellemiyoruz. Prod'da ise KAPALI (fail-closed): eskiden secret
  // unutulunca bu uç kimliksiz açık kalıyordu — canlı testte herhangi biri
  // INITIAL_PURCHASE göndererek istediği kimliği premium yapabildi.
  if (!expected) return process.env.NODE_ENV !== 'production';
  // Sabit zamanlı karşılaştırma: `===` ilk farklı karakterde döndüğü için
  // secret'ı karakter karakter zamanlama farkından tahmin etmeye açıktı.
  const provided = Buffer.from(String(req.headers.authorization || ''));
  const wanted = Buffer.from(`Bearer ${expected}`);
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
}

// POST /webhooks/revenuecat
router.post('/revenuecat', asyncHandler(async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Geçersiz webhook secret.' });
  }

  const event = req.body?.event;
  const userId = event?.app_user_id;
  if (!userId || !event?.type) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'event.app_user_id ve event.type zorunlu.' });
  }

  if (PREMIUM_ACTIVATING_EVENTS.has(event.type)) {
    await userStore.setPremium(userId, true);
  } else if (PREMIUM_DEACTIVATING_EVENTS.has(event.type)) {
    await userStore.setPremium(userId, false);
  } else {
    // CANCELLATION gibi diğer event'ler bilerek yoksayılıyor — kullanıcı
    // dönem sonuna kadar erişimini KORUR, gerçek kapanış EXPIRATION'da gelir.
    logger.info({ userId, eventType: event.type }, '[webhooks] premium durumunu etkilemeyen event, atlandı');
  }

  return res.status(200).json({ ok: true });
}));

module.exports = router;
