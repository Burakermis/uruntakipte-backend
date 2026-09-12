const { Queue, QueueEvents } = require('bullmq');
const { SCRAPE_JOB_TIMEOUT_MS } = require('../constants');

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
};

// BullMQ tamamlanan/başarısız job kayıtlarını VARSAYILAN OLARAK SONSUZA KADAR
// Redis'te tutar. Ölçüm: tamamlanmış bir "check" job kaydı ~400 bayt (kaydın
// kendisi 328 B + tamamlananlar listesindeki girdisi). Bugünkü 11 hedefte bu
// günde ~6 MB; ölçtüğümüz tek-worker tavanında (150 premium ürün, günde
// ~216.000 kontrol) günde ~86 MB, ayda ~2,6 GB eder — ve hiç küçülmez.
// Redis RAM'de çalıştığı için sonu ya "yazma hatası → kuyruk durur → takip
// sessizce ölür" (noeviction) ya da "Redis rastgele anahtar atar" (allkeys-lru)
// olur; ikisi de aylar sonra, ilgisiz görünen bir anda patlayan arızalar.
//
// Bu yüzden her kuyruk kendi saklama politikasını taşıyor. Ölçüt: hata
// ayıklarken gerçekten geriye bakacağımız pencere kadar tut, fazlası yük.
const RETENTION = {
  // Başarılı işler: son birkaç turu görebilmek yeterli.
  completed: { age: 60 * 60, count: 200 },
  // Başarısız işler: asıl incelemek isteyeceklerimiz bunlar, daha uzun tut.
  failed: { age: 24 * 60 * 60, count: 500 },
};

// "scrape" — ilk kez görülen bir URL'i çözüp trackedTarget oluşturan iş
// (bkz. queue/worker-process.js). API process'i (server.js) sadece job'u
// ekleyip sonucunu bekler (routes/products.js) — gerçek Playwright/fetch işi
// AYRI bir process'te, sınırlı concurrency ile çalışır.
//
// DİKKAT: burada `removeOnComplete: true` KULLANILAMAZ. routes/products.js
// job'un sonucunu `waitUntilFinished` ile bekliyor; kayıt, sonucu okunmadan
// silinirse ürün ekleme isteği hata verir. Yaş sınırı bu yüzden job'un kendi
// zaman aşımından (SCRAPE_JOB_TIMEOUT_MS) belirgin biçimde uzun tutuluyor.
const scrapeQueue = new Queue('scrape', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { age: Math.max(RETENTION.completed.age, (SCRAPE_JOB_TIMEOUT_MS / 1000) * 10), count: 200 },
    removeOnFail: RETENTION.failed,
  },
});
// Job'u ekleyen taraf (API process) sonucu await'leyebilsin diye — worker
// process'teki tamamlanma event'lerini dinler.
const scrapeQueueEvents = new QueueEvents('scrape', { connection });

// "check" — worker.js'in periyodik turunda "sırası gelmiş" hedefler için
// eklenen yeniden-tarama işi. Kimse sonucunu await'lemiyor (fire-and-forget,
// bildirim checker.js içinde zaten gönderiliyor) — bu yüzden saklama
// politikası tamamen "hata ayıklarken ne kadar geriye bakmak isteriz"
// sorusuna göre. Sürekli çalışan ve en çok kayıt üreten kuyruk bu.
const checkQueue = new Queue('check', {
  connection,
  defaultJobOptions: { removeOnComplete: RETENTION.completed, removeOnFail: RETENTION.failed },
});

// "retention" — fiyat geçmişi temizliği, tek bir tekrarlayan (repeat) job.
const retentionQueue = new Queue('retention', {
  connection,
  defaultJobOptions: { removeOnComplete: { age: 7 * 24 * 60 * 60, count: 30 }, removeOnFail: RETENTION.failed },
});

module.exports = { connection, scrapeQueue, scrapeQueueEvents, checkQueue, retentionQueue };
