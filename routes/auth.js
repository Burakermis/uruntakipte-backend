const express = require('express');
const { issueToken, newUserId } = require('../auth/token');
const userStore = require('../store/userStore');
const { asyncHandler } = require('../middleware/asyncHandler');
const { registerLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// POST /api/auth/register
// Uygulama ilk açılışta (ya da token'ı yoksa) bir kez çağırır. Sunucu yeni bir
// userId üretir ve onu imzalayan token'ı döner. Kimlik İSTEMCİDEN ALINMAZ: aksi
// halde biri başkasının userId'sini kendi adına "kaydedebilirdi". Token cihazda
// güvenli depoda saklanır ve sonraki her istekte `Authorization: Bearer` ile gider.
router.post('/register', registerLimiter, asyncHandler(async (_req, res) => {
  const userId = newUserId();
  await userStore.getOrCreate(userId);
  return res.status(201).json({ userId, token: issueToken(userId) });
}));

module.exports = router;
