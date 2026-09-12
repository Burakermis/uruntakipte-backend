const trackedTargetStore = require('./store/trackedTargetStore');
const { isTargetDue } = require('./checkSchedule');
const { checkQueue } = require('./queue/scrapeQueue');
const { WORKER_TICK_MS } = require('./constants');
const logger = require('./logger');

// Artık hedefleri KENDİ taramıyor — "sırası gelmiş" (bkz. checkSchedule.js)
// her hedef için bir "check" job'u kuyruğa ekliyor, gerçek tarama işini AYRI
// bir process (queue/worker-process.js) sınırlı concurrency ile çekip
// yapıyor. Bu, tek process + sıralı for-loop'un büyük hedef sayısında
// (ör. 1000+ kullanıcı × 10 ürün) tıkanmasını önlüyor: process içi bekleme
// yerine paralel işleme.
// Her tik'te sırası gelen TÜM hedefler aynı anda kuyruğa giriyordu; ölçümde
// 11 hedefin taraması 3-5 saniyeye sıkışıyordu. Bir insanın gezinmesine hiç
// benzemeyen, bot korumalarının tam da aradığı desen bu. Hedeflere tik
// penceresi içinde küçük bir gecikme dağıtıp istekleri yayıyoruz.
//
// Gecikme RASTGELE DEĞİL, hedef id'sinden türetilen sabit bir "faz": iki
// ardışık kontrol arasındaki mesafe böylece tam olarak tik süresi kadar
// kalır. Rastgele olsaydı, bir tur geç bir turun ardından erken bir tura
// denk gelip vaat edilen aralıktan daha SIK tarama yapabilirdik.
//
// Pencere bilerek tik süresinin üçte biriyle sınırlı: hazır-olma toleransı
// (bkz. checkSchedule.js DUE_TOLERANCE_MS, tik/2) bundan büyük olmalı, aksi
// halde faz kadar geciken hedef bir sonraki tik'te "henüz erken" sayılıp bir
// tur atlar — düzelttiğimiz 2 dakika sorununun aynısı geri gelirdi.
const JITTER_WINDOW_MS = Math.floor(WORKER_TICK_MS / 3);

function checkDelayFor(targetId) {
  // Knuth çarpımsal hash — ardışık id'leri pencereye düzgün dağıtır
  // (id % pencere deseydi, 1sn arayla artan id'ler kümelenirdi).
  return Math.abs((Number(targetId) * 2654435761) % JITTER_WINDOW_MS);
}

async function runCheckCycle() {
  // trackedTargetStore.listActive() sadece en az bir aktif abonesi olan
  // hedefleri döner — aynı ürünü izleyen N kullanıcı olsa da liste TEK satır
  // içerir, yani sayfa TEK kez çekilir (bkz. checker.js). isTargetDue ile
  // ayrıca her hedefin kendi tier-bazlı aralığına göre "sırası geldi mi"
  // filtreleniyor (bkz. checkSchedule.js) — free bir hedef premium'un 1dk'lık
  // tik'inde her seferinde taranmaz, sadece 5dk'da bir sırası gelir.
  const allActive = await trackedTargetStore.listActive();
  const dueFlags = await Promise.all(allActive.map((t) => isTargetDue(t)));
  const targets = allActive.filter((_, i) => dueFlags[i]);

  for (const target of targets) {
    // jobId ile aynı hedefin aynı tikte yanlışlıkla iki kez kuyruğa
    // girmesi engelleniyor (BullMQ aynı id'li aktif/bekleyen job'u yok
    // sayar) — tik süresi işlem süresinden kısa olursa diye bir güvenlik ağı.
    await checkQueue.add(
      'check-target',
      { targetId: target.id },
      { jobId: `check-${target.id}-${Math.floor(Date.now() / WORKER_TICK_MS)}`, delay: checkDelayFor(target.id) }
    );
  }

  if (targets.length > 0) {
    logger.info({ enqueued: targets.length }, '[worker] hedefler check kuyruğuna eklendi');
  }
}

// intervalMs artık "gerçek kontrol aralığı" değil, TABAN TİK süresi —
// gerçek aralık hedef bazında isTargetDue ile belirleniyor (bkz.
// checkSchedule.js). Bu tik en hızlı tier'dan (premium, WORKER_TICK_MS)
// büyük olmamalı, aksi halde premium kullanıcının "1 dakikada bir" vaadi
// tutulamaz — server.js zaten WORKER_TICK_MS'i geçiyor, ama fonksiyon
// yanlışlıkla başka bir değerle çağrılırsa sessizce bozulmasın diye uyarı.
function startWorker(intervalMs) {
  if (intervalMs > WORKER_TICK_MS) {
    logger.warn(
      { intervalMs, fastestTierMs: WORKER_TICK_MS },
      '[worker] tik süresi en hızlı tier aralığından büyük — premium kullanıcılar 1dk garantisini alamayabilir'
    );
  }
  logger.info({ tickMs: intervalMs }, '[worker] taban tik başlıyor (hedef bazlı gerçek aralık için bkz. checkSchedule.js)');
  runCheckCycle(); // açılışta bir kez hemen çalıştır, ilk turu beklemeden
  return setInterval(runCheckCycle, intervalMs);
}

module.exports = { startWorker, runCheckCycle };
