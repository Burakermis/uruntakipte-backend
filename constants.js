// "Stoğa girince bildir" sadece ürün şu an satın ALINAMAZ durumdaysa
// anlamlı. in_stock/low_stock: kullanıcı zaten şimdi satın alabilir ->
// bildirim anlamsız. out_of_stock/coming_soon: satın alınamıyor -> bildirim
// mantıklı. routes/products.js ve checker.js arasında paylaşılıyor.
const NOT_CURRENTLY_PURCHASABLE = new Set(['out_of_stock', 'coming_soon']);

// Ücretsiz/Premium plan farkları (bkz. mobile PremiumScreen mockup'ı — bu
// sayılar oradaki tabloyla birebir eşleşiyor, tek kaynak burası):
//   - maxActiveProducts: aynı anda en fazla kaç AKTİF takip olabilir.
//   - checkIntervalMs: bir hedefin ne sıklıkla yeniden tarandığı (bkz.
//     worker.js). Bir hedefi hem free hem premium kullanıcı izliyorsa, EN
//     HIZLI (premium) aralık uygulanır — premium kullanıcı zaten o hedefi
//     sıklıkla taratıyor, free kullanıcı da bundan bedavaya faydalanır.
//   - reAddCooldownMs: free kullanıcı bir ürünü çıkardıktan sonra YENİ bir
//     ürünü (aynısı ya da başkası) o boşalan slota eklemek için beklemesi
//     gereken süre — "Bekleme süresi yok" satırı Premium'da bunu sıfırlıyor.
const TIER_LIMITS = {
  free: {
    maxActiveProducts: 3,
    checkIntervalMs: 5 * 60 * 1000,
    reAddCooldownMs: 48 * 60 * 60 * 1000,
  },
  premium: {
    maxActiveProducts: Infinity,
    checkIntervalMs: 1 * 60 * 1000,
    reAddCooldownMs: 0,
  },
};

function limitsForTier(isPremium) {
  return isPremium ? TIER_LIMITS.premium : TIER_LIMITS.free;
}

// Worker'ın taban tik süresi (bkz. checkSchedule.js, worker.js) — en hızlı
// tier'a (şu an premium, 1dk) eşit olmalı, aksi halde premium kullanıcının
// "1 dakikada bir" vaadi tutulamaz. Sabit numarayı iki yerde ayrı ayrı
// yazmak yerine tier tablosundan türetiyoruz ki numaralar değişince
// otomatik senkron kalsın.
const WORKER_TICK_MS = Math.min(...Object.values(TIER_LIMITS).map((t) => t.checkIntervalMs));

// Marka bazlı devre kesici / üstel geri çekilme (bkz. checkSchedule.js) —
// art arda başarısız olan bir hedefi worker'ın boşuna denemesini önler.
// Her ardışık başarısızlıkta gereken kontrol aralığı 2^failures ile
// çarpılır (1 hata -> ×2, 2 hata -> ×4, ...), BACKOFF_MAX_MS'te sınırlanır
// — hedef tamamen "kilitlenmiyor" (manuel reset gerektirmiyor), sadece
// giderek seyrekleşen bir hızda denenmeye devam ediyor.
const CIRCUIT_BREAKER = {
  backoffMaxMs: 6 * 60 * 60 * 1000, // en seyrek: 6 saatte bir dene
};

// Yeni bir ürün eklenirken sayfayı çekip çözen kuyruk işinin (bkz.
// queue/worker-process.js) üst sınırı. İki yerde birden gerekiyor —
// routes/products.js sonucu bu kadar bekliyor, queue/scrapeQueue.js ise job
// kayıtlarının saklama süresini bundan türetiyor (sonucu okunmadan silinen
// bir kayıt ekleme isteğini hataya düşürür) — bu yüzden tek kaynak burası.
const SCRAPE_JOB_TIMEOUT_MS = 30000;

module.exports = {
  NOT_CURRENTLY_PURCHASABLE,
  TIER_LIMITS,
  limitsForTier,
  WORKER_TICK_MS,
  CIRCUIT_BREAKER,
  SCRAPE_JOB_TIMEOUT_MS,
};
