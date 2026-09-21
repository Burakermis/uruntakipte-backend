// queue/domainLimiter.js — eşzamanlı işler aynı alan adına en az `delay` aralıkla
// geçmeli (eski "oku, uyu, yaz" sürümü bunu sağlamıyordu; aşağıda aynı testte gösteriliyor).
const { createDomainLimiter } = require('./queue/domainLimiter');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ESKİ davranışın birebir kopyası (yarış gösterimi için).
function oldLimiter(delayMs) {
  const last = new Map();
  return async (url) => {
    const host = new URL(url).hostname;
    const wait = (last.get(host) ?? 0) + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last.set(host, Date.now());
  };
}

async function minGap(waitFn, urls) {
  const starts = [];
  await Promise.all(urls.map(async (u) => { await waitFn(u); starts.push(Date.now()); }));
  starts.sort((a, b) => a - b);
  const byHostGaps = starts.slice(1).map((t, i) => t - starts[i]);
  return Math.min(...byHostGaps);
}

(async () => {
  const DELAY = 120;
  const same = Array.from({ length: 6 }, () => 'https://www.zara.com/a');

  const oldGap = await minGap(oldLimiter(DELAY), same);
  check('ESKİ sürüm: eşzamanlı 6 iş arasındaki en küçük aralık aralığın çok altında (yarış)', oldGap < DELAY / 2, true);

  const limiter = createDomainLimiter(DELAY);
  const gap = await minGap((u) => limiter.waitForSlot(u), same);
  check(`YENİ sürüm: eşzamanlı 6 iş arasındaki en küçük aralık >= ${DELAY - 15}ms (zamanlayıcı toleransı)`, gap >= DELAY - 15, true);

  // Farklı alan adları birbirini beklemez.
  const l2 = createDomainLimiter(DELAY);
  const t0 = Date.now();
  await Promise.all(['https://a.com/x', 'https://b.com/x', 'https://c.com/x'].map((u) => l2.waitForSlot(u)));
  check('farklı alan adları paralel (bekleme yok)', Date.now() - t0 < DELAY / 2, true);

  // Sahte saatle deterministik: bekleme süreleri 0, D, 2D, 3D ve boşta kalınca sıfırlanır.
  let clock = 1000;
  const sleeps = [];
  const l3 = createDomainLimiter(100, { now: () => clock, sleep: async (ms) => { sleeps.push(ms); } });
  const waits = [];
  for (let i = 0; i < 4; i++) waits.push(await l3.waitForSlot('https://x.com/p'));
  check('aynı anda gelen 4 iş: bekleme süreleri', waits, [0, 100, 200, 300]);
  clock += 10000; // uzun süre sessizlik
  check('boşta kaldıktan sonra ilk iş beklemez', await l3.waitForSlot('https://x.com/p'), 0);
  check('geçersiz URL sessizce geçer', await l3.waitForSlot('not a url'), 0);

  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  process.exit(ok ? 0 : 1);
})();
