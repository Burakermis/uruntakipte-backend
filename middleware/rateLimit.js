const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');

const MESSAGE = { error: 'RATE_LIMITED', message: 'Çok fazla istek gönderildi, lütfen biraz sonra tekrar dene.' };

// Sayaçlar nerede tutulur? Bellek içi (varsayılan, geliştirme/test) tek API sürecinde doğru çalışır ama her süreç
// kendi sayacını tutar: birden çok API örneği (ölçekleme, yeniden başlatma) arkasında limit örnek sayısı kadar
// gevşer ve süreç yeniden başlayınca sıfırlanır. Canlıda sayaçlar Redis'te tutulur (tüm örnekler paylaşır).
// Seçim: RATE_LIMIT_STORE=redis|memory; yoksa production -> redis, diğer ortamlar -> memory.
function resolveStoreKind(env = process.env) {
  const explicit = String(env.RATE_LIMIT_STORE || '').toLowerCase();
  if (explicit === 'redis' || explicit === 'memory') return explicit;
  return env.NODE_ENV === 'production' ? 'redis' : 'memory';
}

let redisClient = null;
function getRedisClient() {
  if (!redisClient) {
    const Redis = require('ioredis');
    const { connection } = require('../queue/scrapeQueue');
    // Kısa zaman aşımı + çevrimdışı kuyruk kapalı: Redis düşerse istekler beklemez, hata verip "geç" kararına
    // (passOnStoreError) düşer; sınırlayıcı yüzünden API kilitlenmez.
    redisClient = new Redis({ ...connection, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2000 });
    redisClient.on('error', () => {}); // bağlantı hataları istek bazında zaten yutuluyor
  }
  return redisClient;
}

/**
 * Hız sınırlayıcı üretir. `name`, Redis anahtar önekidir (sınırlayıcılar sayaçları karıştırmasın).
 * Redis erişilemezse istek ENGELLENMEZ (passOnStoreError): sınırlayıcı bir koruma katmanıdır, tek başına
 * kesinti nedeni olmamalı.
 */
function makeLimiter({ name, windowMs, limit }, { store = resolveStoreKind(), client } = {}) {
  const options = { windowMs, limit, standardHeaders: true, legacyHeaders: false, message: MESSAGE };
  if (store === 'redis') {
    const redis = client || getRedisClient();
    options.store = new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: `rl:${name}:` });
    options.passOnStoreError = true;
  }
  return rateLimit(options);
}

// Tarama tetikleyen uçlar (resolve/create) en pahalı olanlar — bir IP'nin scrapeQueue'yu/Playwright'ı kasıtlı ya da
// yanlışlıkla spam'lemesini engeller. Limit "normal kullanım"ın rahatça altında kalmayacak kadar gevşek: bir kullanıcı
// dakikada onlarca ürün eklemez.
const productsLimiter = makeLimiter({ name: 'products', windowMs: 60 * 1000, limit: 60 });

// Genel API için daha gevşek bir taban sınır (limits/devices gibi ucuz okuma uçları dahil) — kaba kuvvet/otomatik
// tarama trafiğine karşı.
const generalLimiter = makeLimiter({ name: 'general', windowMs: 60 * 1000, limit: 300 });

// Yeni kimlik üretimi: yeniden kurulumla ücretsiz limiti sıfırlamayı ve kullanıcı tablosunu şişirmeyi yavaşlatır
// (IP başına saatte 20).
const registerLimiter = makeLimiter({ name: 'register', windowMs: 60 * 60 * 1000, limit: 20 });

module.exports = { productsLimiter, generalLimiter, registerLimiter, makeLimiter, resolveStoreKind };
