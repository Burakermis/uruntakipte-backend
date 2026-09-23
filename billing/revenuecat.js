const { isDevMode } = require('../config');

// RevenueCat, TestFlight/Play iç test satın almalarını (sandbox) canlı
// satın almalarla AYNI webhook ve REST API üzerinden bildirir; yalnızca
// `event.environment` ("SANDBOX" | "PRODUCTION") ve abonelik kaydındaki
// `is_sandbox` alanı onları ayırır. Ayrım yapılmazsa herhangi bir test
// kullanıcısı ücretsiz sandbox satın almasıyla canlı veritabanında premium
// olur. Sandbox yalnızca geliştirme modunda (bkz. config.js) kabul edilir.

function isSandboxEvent(event) {
  return String(event?.environment || '').toUpperCase() === 'SANDBOX';
}

// Sandbox olayı bu ortamda işlenmemeli mi (premium durumunu ne açmalı ne kapatmalı).
function shouldIgnoreEvent(event) {
  return isSandboxEvent(event) && !isDevMode();
}

// Bir entitlement'ın dayandığı satın alma sandbox mu? RevenueCat v1
// subscriber yanıtında entitlement yalnızca `product_identifier` taşır; asıl
// `is_sandbox` bayrağı abonelik (subscriptions) ya da tek seferlik satın alma
// (non_subscriptions, ürün başına bir dizi) kaydındadır.
function isSandboxEntitlement(subscriber, entitlement) {
  const productId = entitlement?.product_identifier;
  if (!productId) return false;
  const sub = subscriber?.subscriptions?.[productId];
  if (sub) return sub.is_sandbox === true;
  const purchases = subscriber?.non_subscriptions?.[productId];
  if (Array.isArray(purchases) && purchases.length > 0) return purchases.every((p) => p.is_sandbox === true);
  return false;
}

// Kullanıcının GERÇEKTEN aktif (süresi dolmamış) ve — geliştirme modu dışında —
// sandbox olmayan bir entitlement'ı var mı. null/undefined expires_date süresiz
// (ör. lifetime) demek.
function hasActiveEntitlement(subscriber, now = Date.now()) {
  const allowSandbox = isDevMode();
  return Object.values(subscriber?.entitlements || {}).some(
    (e) =>
      (!e.expires_date || new Date(e.expires_date).getTime() > now) &&
      (allowSandbox || !isSandboxEntitlement(subscriber, e))
  );
}

module.exports = { isSandboxEvent, shouldIgnoreEvent, isSandboxEntitlement, hasActiveEntitlement };
