// Tik döngüsü ölçeği: worker.js runCheckCycle() her dakika TÜM aktif hedefleri
// gezip "sırası geldi mi" diye bakıyor (checkSchedule.isTargetDue). Bu iş
// hedef sayısıyla nasıl büyüyor, 60sn'lik tik bütçesinin ne kadarını yiyor?
//
// Kullanım (izole DB + Redis gerekir):
//   DATABASE_URL=postgres://.../trackprice_perf REDIS_PORT=6380 node perf/bench-tick.js [500,2000,8000]
const { db, reset, seedUsers, seedTargets, seedSubscriptions, withQueryCount, tableTupleStats, round } = require('./lib');
const { WORKER_TICK_MS } = require('../constants');

// Kuyruğa gerçekten iş eklemiyoruz — ölçtüğümüz DB tarafı; Redis ayrı bir konu.
const { checkQueue } = require('../queue/scrapeQueue');
checkQueue.add = async () => ({});
checkQueue.addBulk = async () => [];
const { runCheckCycle } = require('../worker');

async function main() {
  const scales = (process.argv[2] || '500,2000,8000').split(',').map(Number);
  console.log(`tik bütçesi: ${WORKER_TICK_MS / 1000} sn (bir tik bunu aşarsa döngü kendi üstüne biner)\n`);
  console.log('hedef  abone  tik(ms)  bütçe%  sorgu  sorgu/hedef  users-UPDATE  (tüm hedefler "sırası gelmiş" = en kötü hâl)');

  for (const n of scales) {
    await reset();
    const userCount = Math.ceil(n / 2);
    await seedUsers(userCount, 0.3);
    await seedTargets(n);
    await seedSubscriptions(userCount, 3);
    const subs = Number((await db.query('SELECT count(*) FROM subscriptions')).rows[0].count);

    const before = await tableTupleStats('users');
    const t0 = process.hrtime.bigint();
    const { queries, byVerb } = await withQueryCount(() => runCheckCycle());
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const after = await tableTupleStats('users');

    console.log(
      `${String(n).padStart(5)}  ${String(subs).padStart(5)}  ${String(round(ms)).padStart(7)}  ${String(round((ms / WORKER_TICK_MS) * 100, 1)).padStart(5)}%  ` +
        `${String(queries).padStart(5)}  ${String(round(queries / n, 1)).padStart(11)}  ${String(after.upd - before.upd).padStart(12)}   ${JSON.stringify(byVerb)}`
    );
  }
  await checkQueue.close();
  await db.pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
