const subscriptionStore = require('./store/subscriptionStore');
const userStore = require('./store/userStore');
const { limitsForTier, CIRCUIT_BREAKER, WORKER_TICK_MS } = require('./constants');

// Worker sabit periyotlu tik'ler hâlinde çalışıyor (bkz. worker.js), ama
// "sırası geldi mi" ölçütü BİR ÖNCEKİ KONTROLÜN BİTİŞİNDEN itibaren
// sayıyordu. Kontrol 1-6sn sürdüğü için bir sonraki tik geldiğinde aradan
// 60sn değil ~55sn geçmiş oluyor → hedef "daha erken" sayılıp atlanıyor, bir
// sonraki tik'i bekliyordu. ÖLÇÜM: premium hedefler 60sn yerine 114-118sn'de
// bir kontrol ediliyordu, yani vaat edilen aralığın iki katı. Tik süresinin
// yarısı kadar tolerans, kontrol bir tik içinde bittiği sürece hedefin her
// tik'te yakalanmasını garantiler (daha sık kontrol edilmesine yol açmaz:
// üst sınır zaten tik periyodu).
const DUE_TOLERANCE_MS = WORKER_TICK_MS / 2;

// Bir hedefin taranması gereken EN HIZLI aralık: aktif abonelerinden
// herhangi biri premium ise 1dk, hepsi ücretsizse 5dk (bkz. constants.js
// TIER_LIMITS). Bir hedefi hem free hem premium kullanıcı izliyorsa free
// kullanıcı da premium'un hızlı aralığından bedavaya faydalanır — paylaşılan
// trackedTarget mimarisinin doğal bir sonucu.
async function requiredIntervalMsForTarget(targetId) {
  const subs = await subscriptionStore.listByTarget(targetId);
  let min = Infinity;
  for (const sub of subs) {
    const { checkIntervalMs } = limitsForTier(await userStore.isPremium(sub.userId));
    if (checkIntervalMs < min) min = checkIntervalMs;
  }
  return min;
}

// Art arda başarısız olan bir hedef için gereken aralığı üstel olarak
// büyütür (bkz. constants.js CIRCUIT_BREAKER) — Akamai gibi korumalar
// tarafından sürekli engellenen bir hedefi worker her tik'te tekrar
// tekrar denemez, ama tamamen de "ölü" saymaz (manuel reset yok, sadece
// giderek seyrekleşir; bir kontrol başarılı olur olmaz checker.js
// consecutiveFailures'ı sıfırlar ve normal hıza döner).
function applyCircuitBreaker(baseIntervalMs, consecutiveFailures) {
  if (!consecutiveFailures) return baseIntervalMs;
  const backoffMs = baseIntervalMs * 2 ** consecutiveFailures;
  return Math.min(backoffMs, CIRCUIT_BREAKER.backoffMaxMs);
}

// Hiç kontrol edilmemişse ya da gereken aralık geçmişse "sırası geldi"
// demektir. worker.js her tik'te bunu kullanarak listActive()'i filtreler;
// check-now endpoint'i (manuel yenileme) bilerek bunu ATLAR.
async function isTargetDue(target, now = Date.now()) {
  // Ölçüt son BAŞARILI kontrol değil, son DENEME. Fark kritik: checker.js
  // başarısız bir kontrolde last_checked_at'i (haklı olarak) güncellemiyor —
  // eğer geri çekilmeyi ona göre hesaplarsak, hiç başarılı olamayan bir hedef
  // için "üzerinden geçen süre" sonsuza kadar büyür, 6 saatlik tavana (bkz.
  // CIRCUIT_BREAKER.backoffMaxMs) çarptığı anda da hedef HER TİK'te yeniden
  // denenmeye başlar. Yani devre kesici ilk 6 saat çalışıp sonra sessizce
  // devre dışı kalıyordu — silinmiş bir ürün ya da engelli bir marka için
  // günde ~1440 istek demek, IP engellenmesinin en kestirme yolu.
  const lastAttempt = target.lastAttemptAt || target.lastCheckedAt;
  if (!lastAttempt) return true;
  const baseIntervalMs = await requiredIntervalMsForTarget(target.id);
  const requiredMs = applyCircuitBreaker(baseIntervalMs, target.consecutiveFailures);
  return now - new Date(lastAttempt).getTime() >= requiredMs - DUE_TOLERANCE_MS;
}

module.exports = { requiredIntervalMsForTarget, isTargetDue };
