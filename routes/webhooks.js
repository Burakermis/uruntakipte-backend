const crypto = require('crypto');
const express = require('express');
const userStore = require('../store/userStore');
const logger = require('../logger');
const { isDevMode } = require('../config');
const { maskId } = require('../middleware/requestLog');
const { shouldIgnoreEvent, fetchPremiumState } = require('../billing/revenuecat');
const { setPlan } = require('../billing/plan');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// RevenueCat, StoreKit/Play Billing'in gerçek satın alma makbuzunu ZATEN doğrulayıp bu webhook'u tetikliyor — burada
// tekrar bir makbuz doğrulaması YAPMIYORUZ, sadece "hangi kullanıcının (RevenueCat App User ID = userId, bkz.
// mobile/src/purchases.ts) durumu ne oldu" bilgisini billing/plan.js'e aktarıyoruz.
//
// Olay türüne göre iki yol:
//  - Aktifleştirenler (satın alma, yenileme...): doğrudan premium. Hızlı ve dış çağrı gerektirmez.
//  - Durumu TÜM yetkilere bağlı olanlar (EXPIRATION, CANCELLATION, TRANSFER): olay tek başına yetmez — kullanıcının
//    başka bir aktif yetkisi olabilir, iade/aktarım olayın kendisinden anlaşılmaz. RevenueCat'e sorup gerçek duruma
//    bakıyoruz; sorgu mümkün değilse (anahtar yok/kesinti) güvenli varsayıma düşülür (aşağıda).
// Her olay, zamanı daha eski olan bir durumu ezmez (geç gelen yeniden denemeler, sıra karışması).
const PREMIUM_ACTIVATING_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'NON_RENEWING_PURCHASE',
]);

// Misafir (kayıtsız) RevenueCat kimlikleri bizim kullanıcılarımız değil: satır açmayız.
const ANONYMOUS_ID = /^\$RCAnonymousID:/i;

function isAuthorized(req) {
  const expected = process.env.REVENUECAT_WEBHOOK_SECRET;
  // Secret tanımlanmadıysa (henüz RevenueCat hesabı kurulmadıysa) yalnızca
  // AÇIKÇA geliştirme modunda (NODE_ENV=development|test) engellemiyoruz; diğer
  // her durumda (production, tanımsız, yazım hatası) KAPALI (fail-closed):
  // eskiden secret unutulunca bu uç kimliksiz açık kalıyordu — canlı testte
  // herhangi biri INITIAL_PURCHASE göndererek istediği kimliği premium yapabildi.
  if (!expected) return isDevMode();
  // Sabit zamanlı karşılaştırma: `===` ilk farklı karakterde döndüğü için
  // secret'ı karakter karakter zamanlama farkından tahmin etmeye açıktı.
  const provided = Buffer.from(String(req.headers.authorization || ''));
  const wanted = Buffer.from(`Bearer ${expected}`);
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
}

// RevenueCat'e sorarak uygula; sorgulanamazsa `fallback` (true/false) ya da null (hiçbir şey yapma).
async function applyFromRevenueCat(userId, { fallback, eventAtMs, eventType }) {
  const state = await fetchPremiumState(userId);
  if (state.ok) return setPlan(userId, state.isPremium, { eventAtMs });
  if (fallback === null) {
    logger.warn({ userId: maskId(userId), eventType, reason: state.reason }, '[webhooks] RevenueCat sorgulanamadı, olay atlandı (uzlaştırma düzeltir)');
    return null;
  }
  return setPlan(userId, fallback, { eventAtMs });
}

const realIds = (list) => (Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && id && !ANONYMOUS_ID.test(id));

// POST /webhooks/revenuecat
router.post('/revenuecat', asyncHandler(async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Geçersiz webhook secret.' });
  }

  const event = req.body?.event;
  if (!event?.type) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'event.type zorunlu.' });
  }

  // Sandbox (TestFlight/iç test) olayları canlıda premium durumunu ne açar ne
  // kapatır (bkz. billing/revenuecat.js). 200 dönüyoruz ki RevenueCat yeniden denemesin.
  if (shouldIgnoreEvent(event)) {
    logger.info({ userId: maskId(event.app_user_id), eventType: event.type }, '[webhooks] sandbox olayı canlıda yok sayıldı');
    return res.status(200).json({ ok: true, ignored: 'SANDBOX' });
  }

  const eventAtMs = Number(event.event_timestamp_ms) > 0 ? Number(event.event_timestamp_ms) : null;
  // Silinmiş hesap için gelen olaylar (ör. mağazada hâlâ süren abonelik yenilenir) hesabı geri doğurmasın.
  const isLive = async (userId) => !(await userStore.isDeleted(userId));

  if (event.type === 'TRANSFER') {
    // Yetkiler bir kimlikten diğerine taşındı (cihaz değişimi, hesap birleştirme). Eskisinde premium kalırsa iki kimlik
    // tek abonelikle premium olur. Her iki taraf da gerçek duruma göre yeniden değerlendirilir.
    const to = realIds(event.transferred_to);
    const from = realIds(event.transferred_from).filter((id) => !to.includes(id));
    for (const [ids, fallback] of [[from, false], [to, true]]) {
      for (const id of ids) {
        if (await isLive(id)) await applyFromRevenueCat(id, { fallback, eventAtMs, eventType: event.type });
      }
    }
    return res.status(200).json({ ok: true });
  }

  const userId = event.app_user_id;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'event.app_user_id zorunlu.' });
  }
  if (ANONYMOUS_ID.test(userId)) {
    return res.status(200).json({ ok: true, ignored: 'ANONYMOUS' });
  }
  if (!(await isLive(userId))) {
    logger.info({ userId: maskId(userId), eventType: event.type }, '[webhooks] silinmiş hesap için olay, yok sayıldı');
    return res.status(200).json({ ok: true, ignored: 'ACCOUNT_DELETED' });
  }

  if (PREMIUM_ACTIVATING_EVENTS.has(event.type)) {
    await setPlan(userId, true, { eventAtMs });
  } else if (event.type === 'EXPIRATION') {
    // Başka aktif yetkisi varsa premium kalır; sorgulanamazsa süre dolmuştur.
    await applyFromRevenueCat(userId, { fallback: false, eventAtMs, eventType: event.type });
  } else if (event.type === 'CANCELLATION') {
    // Çoğu iptal "yenilenmeyecek" demektir, erişim dönem sonuna kadar sürer; ama iade de bu olayla gelir ve erişim hemen
    // biter. Ayırt etmenin güvenilir yolu gerçek duruma bakmak. Sorgulanamazsa dokunulmaz (uzlaştırma düzeltir).
    await applyFromRevenueCat(userId, { fallback: null, eventAtMs, eventType: event.type });
  } else {
    // BILLING_ISSUE gibi diğer olaylar bilerek yoksayılıyor: ödeme sorununda RevenueCat erişimi ek süreyle korur,
    // gerçek kapanış EXPIRATION'da gelir.
    logger.info({ userId: maskId(userId), eventType: event.type }, '[webhooks] premium durumunu etkilemeyen event, atlandı');
  }

  return res.status(200).json({ ok: true });
}));

module.exports = router;
