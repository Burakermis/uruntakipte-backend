const rateLimit = require('express-rate-limit');

// Tarama tetikleyen uçlar (resolve/create) en pahalı olanlar — bir IP'nin
// scrapeQueue'yu/Playwright'ı kasıtlı ya da yanlışlıkla spam'lemesini
// engeller. Limit "normal kullanım"ın rahatça altında kalmayacak kadar
// gevşek: bir kullanıcı dakikada onlarca ürün eklemez.
const productsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Çok fazla istek gönderildi, lütfen biraz sonra tekrar dene.' },
});

// Genel API için daha gevşek bir taban sınır (limits/devices gibi ucuz
// okuma uçları dahil) — kaba kuvvet/otomatik tarama trafiğine karşı.
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Çok fazla istek gönderildi, lütfen biraz sonra tekrar dene.' },
});

module.exports = { productsLimiter, generalLimiter };
