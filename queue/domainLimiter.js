// Aynı alan adına art arda çok hızlı istek atmamak için (Akamai gibi bot
// korumaları bunu şüpheli buluyor) — eskiden worker.js'in sıralı for-loop'unda
// doğal olarak sağlanıyordu, concurrency>1 ile açıkça uygulanması gerekiyor.
//
// Slot ATOMİK rezerve edilir: "sıradaki boş zamanı oku, bir sonrakini yaz"
// adımları arasında await YOK. Eski sürüm önce okuyup, uyuyup, SONRA yazıyordu:
// eşzamanlı iki iş aynı eski değeri okuyup aynı süre uyuyor ve birlikte istek
// atıyordu — perf/bench-worker.js'te 74 Zara hedefi 1,5sn aralıkla en az 111sn
// sürmesi gerekirken 60sn'de bitti (aralık fiilen ~0,8sn'ye düşmüştü).
function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createDomainLimiter(delayMs, { now = Date.now, sleep = defaultSleep } = {}) {
  const nextFreeAtByHost = new Map();

  // Çağıran, kendi slotu gelene kadar bekler; beklediği süreyi (ms) döner.
  async function waitForSlot(url) {
    const host = hostnameOf(url);
    if (!host) return 0;
    const t = now();
    const slotAt = Math.max(t, nextFreeAtByHost.get(host) ?? 0);
    nextFreeAtByHost.set(host, slotAt + delayMs); // sıradaki iş bir aralık sonrasını alır
    const wait = slotAt - t;
    if (wait > 0) await sleep(wait);
    return wait;
  }

  return { waitForSlot };
}

module.exports = { createDomainLimiter };
