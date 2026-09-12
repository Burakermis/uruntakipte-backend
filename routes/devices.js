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

module.exports = router;
