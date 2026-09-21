// Worker kapasitesi: N hedefin HEPSİ aynı anda "sırası gelmiş" olduğunda (tik
// başı ya da worker yeniden başladığında) tek worker süreci kaç saniyede
// eritiyor? Sonuç, "1dk vaadini kaç hedefe kadar sürdürebiliriz" sorusunun
// doğrudan cevabı: N hedef 60sn'de bitiyorsa N premium hedef sürdürülebilir.
//
// Gerçek worker-process.js çalışır (concurrency, alan-adı aralığı, checker,
// parser, DB) ama sayfa çekimi perf/stub-fetch.js ile ölçülmüş gecikmeyle
// taklit edilir — canlı sitelere istek gitmez.
//
// Kullanım: DATABASE_URL=postgres://.../trackprice_perf REDIS_PORT=6380 node perf/bench-worker.js [hedefSayisi=120]
const { spawn } = require('child_process');
const readline = require('readline');
const { db, reset, seedUsers, seedTargets, seedSubscriptions, round, root } = require('./lib');
const { checkQueue } = require('../queue/scrapeQueue');

const CONCURRENCY = Number(process.env.CHECK_CONCURRENCY || 5); // queue/worker-process.js CHECK_CONCURRENCY (env ile aynı değer verilmeli)
const DOMAIN_DELAY_MS = 1500; // queue/worker-process.js DOMAIN_DELAY_MS

async function main() {
  const n = Number(process.argv[2] || 120);
  const timeoutS = Number(process.env.WORKER_BENCH_TIMEOUT_S || 400);

  await reset();
  await seedUsers(Math.ceil(n / 2), 0.3);
  await seedTargets(n);
  await seedSubscriptions(Math.ceil(n / 2), 3);
  await checkQueue.obliterate({ force: true });

  const child = spawn(process.execPath, ['-r', './perf/stub-fetch.js', 'queue/worker-process.js'], {
    cwd: root,
    env: { ...process.env, LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const checks = [];
  const problems = []; // worker'ın uyarı/hata satırları (ör. job başarısız, stalled)
  let started = null;
  const ready = new Promise((resolve) => {
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if ((o.msg || '').includes('worker\'ları başladı')) resolve();
      if (o.msg === '[worker-process] kontrol tamamlandı') checks.push({ ...o, at: Date.now() });
      if (o.level >= 40) problems.push(`${o.msg}${o.err ? ' — ' + o.err : ''}`);
    });
  });
  await ready;

  // Tüm hedefler için iş ekle (gecikmesiz — en kötü hâl: hepsi aynı anda).
  const ids = (await db.query('SELECT id FROM tracked_targets ORDER BY id')).rows.map((r) => r.id);
  started = Date.now();
  for (const id of ids) await checkQueue.add('check-target', { targetId: id }, { jobId: `perf-${id}` });

  const deadline = Date.now() + timeoutS * 1000;
  while (checks.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  const elapsedMs = (checks.length ? checks[checks.length - 1].at : Date.now()) - started;
  const counts = await checkQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
  child.kill();
  if (checks.length < n || problems.length) {
    console.log(`UYARI: kuyruk durumu ${JSON.stringify(counts)}; worker uyarı/hata satırı: ${problems.length}`);
    for (const p of [...new Set(problems)].slice(0, 5)) console.log(`  - ${p}`);
  }

  const ok = checks.filter((c) => c.ok).length;
  const scan = checks.reduce((s, c) => s + c.checkMs, 0);
  const wait = checks.reduce((s, c) => s + c.domainWaitMs, 0);
  const slotMs = CONCURRENCY * elapsedMs;
  console.log(`hedef: ${n} (marka karışımı gerçekçi, %30 premium) | tamamlanan: ${checks.length}/${n}, başarılı: ${ok}`);
  console.log(`süre: ${round(elapsedMs / 1000, 1)} sn  ->  kapasite ≈ ${round((checks.length / elapsedMs) * 60000)} kontrol/dk (tek worker, ${CONCURRENCY} slot)`);
  console.log(
    `slot zamanı: gerçek tarama %${round((scan / slotMs) * 100)}, alan-adı beklemesi (slot İÇİNDE uyuyarak) %${round((wait / slotMs) * 100)}, ` +
      `boş/diğer %${round(100 - ((scan + wait) / slotMs) * 100)}`
  );

  const byBrand = {};
  for (const c of checks) {
    const b = (byBrand[c.brand] = byBrand[c.brand] || { n: 0, wait: 0, scan: 0, last: 0 });
    b.n++; b.wait += c.domainWaitMs; b.scan += c.checkMs; b.last = Math.max(b.last, c.at - started);
  }
  console.log('\nmarka         hedef  ort.tarama(ms)  ort.alan-bekleme(ms)  alan-adı alt sınırı(sn)  son bitiş(sn)');
  for (const [brand, b] of Object.entries(byBrand).sort((x, y) => y[1].n - x[1].n)) {
    console.log(
      `${brand.padEnd(13)} ${String(b.n).padStart(5)}  ${String(round(b.scan / b.n)).padStart(14)}  ${String(round(b.wait / b.n)).padStart(20)}  ` +
        `${String(round((b.n * DOMAIN_DELAY_MS) / 1000, 1)).padStart(23)}  ${String(round(b.last / 1000, 1)).padStart(12)}`
    );
  }
  const top = Object.entries(byBrand).sort((x, y) => y[1].n - x[1].n)[0];
  console.log(
    `\nen kalabalık marka (${top[0]}, ${top[1].n} hedef) alan-adı aralığı yüzünden en az ${round((top[1].n * DOMAIN_DELAY_MS) / 1000, 1)} sn sürer; ` +
      `1dk'lık bir tikte tek marka en fazla ${Math.floor(60000 / DOMAIN_DELAY_MS)} hedef taşıyabilir.`
  );
  console.log(elapsedMs <= 60000 ? `=> ${n} premium hedef 1dk'lık tike SIĞIYOR` : `=> ${n} premium hedef 1dk'lık tike SIĞMIYOR (${round(elapsedMs / 1000)} sn)`);

  await checkQueue.close();
  await db.pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
