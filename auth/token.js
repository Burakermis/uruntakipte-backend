const crypto = require('crypto');
const { isDevMode } = require('../config');

// Uygulamanın hesap/parola sistemi yok: kimlik, sunucunun ilk açılışta ürettiği
// opak bir userId ve onu imzalayan bir erişim anahtarı (token). Token =
// `<userId>.<HMAC-SHA256(userId)>`; sunucu durum tutmaz (DB sorgusu yok), yalnızca
// AUTH_SECRET'ı bilen biri geçerli bir token üretebilir. Böylece `userId` artık tek
// başına bir erişim anahtarı değil: onu bilmek başkasının listesini okumaya,
// silmeye ya da bildirimlerini yönlendirmeye yetmez (bkz. middleware/auth.js).
//
// Sınırı: token'ı iptal etmek tek tek mümkün değil (yalnızca AUTH_SECRET'ı değiştirmek
// hepsini geçersiz kılar). Yeniden kurulumla yeni kimlik alıp ücretsiz limiti
// sıfırlamak da bununla engellenmez — o, cihaz doğrulaması (App Attest / Play
// Integrity) ya da gerçek hesap ister.

// Yalnızca yerel geliştirme/test için sabit anahtar. Canlıda AUTH_SECRET zorunlu
// (bkz. assertConfigured) — bilinen bir anahtarla herkes token imzalayabilirdi.
const DEV_SECRET = 'dev-only-auth-secret-do-not-use-in-production';
const MIN_SECRET_LENGTH = 32;

function getSecret() {
  const secret = process.env.AUTH_SECRET;
  if (secret) return secret;
  return isDevMode() ? DEV_SECRET : null;
}

// Sunucu açılışında çağrılır: canlıda anahtar yoksa ya da kısaysa süreç başlamaz
// (kimliksiz bir API'nin sessizce açık kalmasından iyidir).
function assertConfigured() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (isDevMode()) return;
    throw new Error('AUTH_SECRET tanımlı değil. Canlıda en az 32 karakterlik rastgele bir değer verin (ör. `openssl rand -hex 32`).');
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET çok kısa (${secret.length}); en az ${MIN_SECRET_LENGTH} karakter olmalı.`);
  }
}

function sign(userId) {
  const secret = getSecret();
  if (!secret) throw new Error('AUTH_SECRET tanımlı değil.');
  return crypto.createHmac('sha256', secret).update(userId).digest('base64url');
}

function newUserId() {
  return crypto.randomUUID();
}

function issueToken(userId) {
  return `${userId}.${sign(userId)}`;
}

// Geçerliyse userId'yi, değilse null döndürür. İmza sabit sürede karşılaştırılır.
function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  let expected;
  try {
    expected = Buffer.from(sign(userId));
  } catch {
    return null; // anahtar yok -> hiçbir token geçerli değil (fail-closed)
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return userId;
}

module.exports = { issueToken, verifyToken, newUserId, assertConfigured };
