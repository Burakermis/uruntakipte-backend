const express = require('express');
const deviceTokenStore = require('../store/deviceTokenStore');
const { isExpoPushToken } = require('../notifications/expoPush');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// POST /api/devices
// Mobil uygulama bildirim izni alıp bir Expo push token elde ettiğinde
// çağırır. Aynı token tekrar gönderilirse (uygulama her açılışta göndermesi
// normal) sadece güncellenir, yinelenmez.
router.post('/', asyncHandler(async (req, res) => {
  const { userId, expoPushToken, platform } = req.body || {};

  if (!userId || !expoPushToken) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'userId ve expoPushToken zorunlu.' });
  }
  if (!isExpoPushToken(expoPushToken)) {
    return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Geçerli bir Expo push token değil.' });
  }

  const record = await deviceTokenStore.upsert({ userId, expoPushToken, platform: platform ?? 'unknown' });
  return res.status(201).json(record);
}));

// DELETE /api/devices?userId=... — kullanıcı uygulamadaki "Bildirimler" anahtarını kapattığında
// çağrılır: bu kullanıcının push token'ları silinir ve bildirim gönderilmez. (Mağaza kuralları
// — Apple 4.5.4 — uygulama içinden bildirimden çıkış yolu istiyor; işletim sistemi izni
// uygulamadan geri alınamadığı için kapatma sunucu tarafında yapılır.) Anahtar tekrar
// açılınca uygulama POST /api/devices ile yeniden kaydolur.
// Erişim anahtarı yine userId (bkz. DELETE /api/products/:id). Kayıt yoksa da 204: idempotent.
router.delete('/', asyncHandler(async (req, res) => {
  const { userId } = req.query;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'userId query param zorunlu.' });
  }

  await deviceTokenStore.removeByUser(userId);
  return res.status(204).send();
}));

module.exports = router;
