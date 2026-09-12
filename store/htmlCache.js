const Redis = require('ioredis');
const logger = require('../logger');

// "Ürün Ekle" akışı iki adımdan oluşuyor: önce POST /products/resolve sayfayı
// çekiyor, saniyeler sonra POST /products aynı sayfanın verisine ihtiyaç
// duyuyor. Eskiden bu HTML araya TELEFONU sokarak taşınıyordu: resolve onu
// yanıtta gönderiyor, mobil "Takibe Al"da geri yüklüyordu.
//
// ÖLÇÜM (Bershka ürünü, gerçek yanıt): resolve yanıtı 1027 KB, bunun 1009 KB'ı
// HTML — işe yarayan veri (renk/beden/fiyat/stok) sadece 3 KB. Yani telefon
// 3 KB bilgi için ~2 MB veri indirip geri yüklüyordu. localhost'ta bedava
// göründüğü için gözden kaçıyordu; hücresel bağlantıda bu, ekleme akışının
// en büyük tek kalemi.
//
// Çözüm: HTML sunucuda kalsın. Redis zaten kuyruk için ayakta (bkz.
// queue/scrapeQueue.js) ve API ile worker AYRI process'ler olduğu için
// process-içi bir Map işe yaramazdı — paylaşılan bir depo şart.
const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
};

const redis = new Redis(connection);
redis.on('error', (err) => logger.error({ err: err.message }, '[htmlCache] Redis hatası'));

// Kullanıcının "Ürünü Getir" ile "Takibe Al" arasında geçirdiği süre kadar
// yaşaması yeterli (renk/beden seçimi). Uzun tutmanın anlamı yok: süresi
// dolarsa akış zaten eski davranışına, sayfayı yeniden taramaya düşer.
const TTL_SECONDS = 600;

function cacheKey(urlKey) {
  return `html:${urlKey}`;
}

/**
 * Çekilen HTML'i, o sayfaya işaret eden anahtarların HEPSİ için saklar.
 * İki anahtar gerekiyor çünkü resolve HAM url ile çağrılıyor, POST /products
 * ise mobilin elindeki canonicalUrl ile — ikisinin normalize anahtarı farklı
 * olabiliyor (bkz. scraper/normalizeUrl.js).
 */
async function put(urlKeys, html) {
  if (!html) return;
  const keys = [...new Set((Array.isArray(urlKeys) ? urlKeys : [urlKeys]).filter(Boolean))];
  await Promise.all(keys.map((key) => redis.set(cacheKey(key), html, 'EX', TTL_SECONDS))).catch((err) =>
    // Önbellek bir hızlandırma, doğruluk kaynağı değil — yazamazsak akış
    // sadece eski hâline (sayfayı yeniden tara) döner, istek başarısız olmaz.
    logger.error({ err: err.message }, '[htmlCache] yazılamadı, sayfa gerekirse yeniden taranacak')
  );
}

async function take(urlKey) {
  if (!urlKey) return null;
  try {
    return await redis.get(cacheKey(urlKey));
  } catch (err) {
    logger.error({ err: err.message }, '[htmlCache] okunamadı');
    return null;
  }
}

module.exports = { put, take, TTL_SECONDS };
