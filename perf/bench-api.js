// API uçlarının yük altındaki gecikmesi: GET /products (abone sayısına göre),
// GET /users/:id/limits, POST /products (mevcut hedefe abonelik) ve — en
// önemlisi — tik döngüsü ÇALIŞIRKEN. Üretimde tik API sürecinin içinde
// (server.js startWorker) ve aynı 10 bağlantılık DB havuzunu paylaşıyor; büyük
// bir tik kullanıcı isteklerini havuzda bekletiyor mu?
//
// Rate limiter (IP başına 60-300/dk) bu testte YOK: tek makineden yüzlerce
// istemciyi taklit ediyoruz, gerçekte her istemcinin kendi IP'si var.
//
// Kullanım: DATABASE_URL=postgres://.../trackprice_perf REDIS_PORT=6380 node perf/bench-api.js [hedefSayisi=4000]
const express = require('express');
const { db, reset, seedUsers, seedTargets, seedSubscriptions, summarize, round } = require('./lib');
const { checkQueue } = require('../queue/scrapeQueue');
checkQueue.add = async () => ({});
checkQueue.addBulk = async () => [];
const { runCheckCycle } = require('../worker');

const productsRouter = require('../routes/products');
const usersRouter = require('../routes/users');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/products', productsRouter);
  app.use('/api/users', usersRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'INTERNAL_ERROR', message: String(err && err.message) }));
  return app;
}

async function runLoad({ name, base, concurrency, durationMs, request }) {
  const latencies = [];
  const statuses = {};
  const end = Date.now() + durationMs;
  let seq = 0;
  async function worker() {
    while (Date.now() < end) {
      const t0 = process.hrtime.bigint();
      let status;
      try {
        status = await request(base, seq++);
      } catch {
        status = 'ERR';
      }
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
      statuses[status] = (statuses[status] || 0) + 1;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const s = summarize(latencies);
  const bad = Object.entries(statuses).filter(([k]) => !/^2/.test(k)).reduce((a, [, v]) => a + v, 0);
  console.log(
    `${name.padEnd(46)} c=${String(concurrency).padStart(3)}  ${String(round(latencies.length / (durationMs / 1000))).padStart(5)} rps  ` +
      `p50 ${String(round(s.p50, 1)).padStart(7)}  p95 ${String(round(s.p95, 1)).padStart(7)}  p99 ${String(round(s.p99, 1)).padStart(7)} ms  hata ${bad}`
  );
  return s;
}

async function main() {
  const targets = Number(process.argv[2] || 4000);
  const durationMs = Number(process.env.API_BENCH_SECONDS || 6) * 1000;

  await reset();
  const userCount = Math.ceil(targets / 2);
  await seedUsers(userCount, 0.3);
  await seedTargets(targets);
  await seedSubscriptions(userCount, 3);
  // Ağır kullanıcılar: 5 / 50 / 200 ürün izleyen (premium sınırsız).
  for (const k of [5, 50, 200]) {
    await db.query(
      `INSERT INTO users (user_id, is_premium) VALUES ($1, true) ON CONFLICT (user_id) DO UPDATE SET is_premium = true`,
      [`perf-heavy-${k}`]
    );
    await db.query(
      `INSERT INTO subscriptions (user_id, target_id, sku, active, notify_on_price_drop, last_notified_price, last_notified_availability)
       SELECT $1, id, 'perf-sku', true, true, 100, 'in_stock' FROM tracked_targets ORDER BY id DESC LIMIT $2`,
      [`perf-heavy-${k}`, k]
    );
  }
  // Fiyat geçmişi: her hedef için 200 satır (dakikada bir kontrolün ~3 saati).
  await db.query(
    `INSERT INTO price_history (target_id, sku, price, availability, checked_at)
     SELECT t.id, 'perf-sku', 100 + ((g / 100) % 2) * 10, 'in_stock', now() - (g || ' minutes')::interval
     FROM tracked_targets t CROSS JOIN generate_series(1, 200) g`
  );
  await db.query('ANALYZE');
  const urls = (await db.query('SELECT url FROM tracked_targets ORDER BY id LIMIT 1000')).rows.map((r) => r.url);

  const server = await new Promise((resolve) => {
    const s = buildApp().listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`hedef: ${targets}, abone: ${(await db.query('SELECT count(*) FROM subscriptions')).rows[0].count}, fiyat geçmişi: ${(await db.query('SELECT count(*) FROM price_history')).rows[0].count} satır, DB havuzu: 10 bağlantı\n`);

  const get = (path) => async (b) => (await fetch(`${b}${path}`).then(async (r) => (await r.arrayBuffer(), r.status)));
  const post = (path, bodyFn) => async (b, i) =>
    (await fetch(`${b}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyFn(i)) }).then(async (r) => (await r.arrayBuffer(), r.status)));

  await get('/api/users/perf-heavy-50/limits')(base); // ısınma
  console.log('senaryo                                        eşzamanlı   istek/sn   gecikme');
  for (const c of [1, 10, 40]) await runLoad({ name: 'GET /users/:id/limits', base, concurrency: c, durationMs, request: get('/api/users/perf-heavy-50/limits') });
  for (const k of [5, 50, 200]) {
    for (const c of [1, 10]) await runLoad({ name: `GET /products (kullanıcı ${k} ürün izliyor)`, base, concurrency: c, durationMs, request: get(`/api/products?userId=perf-heavy-${k}`) });
  }
  for (const c of [1, 10]) {
    await runLoad({
      name: 'POST /products (mevcut hedefe abonelik)',
      base, concurrency: c, durationMs,
      request: post('/api/products', (i) => ({ userId: `perf-new-${c}-${i}-${Date.now()}`, url: urls[i % urls.length], sku: 'perf-sku' })),
    });
  }

  // Tik döngüsü çalışırken kullanıcı istekleri: tik arka arkaya sürekli koşuyor (en kötü hâl).
  console.log('\n--- tik döngüsü (runCheckCycle) AYNI süreçte, aynı DB havuzunda sürekli çalışırken ---');
  let ticking = true;
  let tickMs = [];
  const tickLoop = (async () => {
    while (ticking) {
      const t0 = process.hrtime.bigint();
      await runCheckCycle();
      tickMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  })();
  await runLoad({ name: 'GET /products (50 ürün) + tik', base, concurrency: 10, durationMs: durationMs * 2, request: get('/api/products?userId=perf-heavy-50') });
  await runLoad({ name: 'GET /users/:id/limits + tik', base, concurrency: 10, durationMs: durationMs * 2, request: get('/api/users/perf-heavy-50/limits') });
  ticking = false;
  await tickLoop;
  console.log(`(tik ${tickMs.length} kez tamamlandı, ort. ${round(tickMs.reduce((a, b) => a + b, 0) / tickMs.length)} ms)`);

  server.close();
  await checkQueue.close();
  await db.pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
