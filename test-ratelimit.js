// Hız sınırlayıcı: Redis deposu örnekler arasında paylaşılır, Redis düşünce istek engellenmez. Redis gerekir.
process.env.NODE_ENV = 'test';
const express = require('express');
const Redis = require('ioredis');
const { connection } = require('./queue/scrapeQueue');
const { makeLimiter, resolveStoreKind } = require('./middleware/rateLimit');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}
async function serve(limiter) {
  const app = express();
  app.use(limiter);
  app.get('/', (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const hit = (srv) => fetch(srv.base + '/').then((r) => r.status);

(async () => {
  console.log('--- 1) depo seçimi');
  check('production -> redis', resolveStoreKind({ NODE_ENV: 'production' }), 'redis');
  check('development/test -> memory', [resolveStoreKind({ NODE_ENV: 'development' }), resolveStoreKind({ NODE_ENV: 'test' }), resolveStoreKind({})], ['memory', 'memory', 'memory']);
  check('RATE_LIMIT_STORE geçersiz kılar', [resolveStoreKind({ NODE_ENV: 'production', RATE_LIMIT_STORE: 'memory' }), resolveStoreKind({ NODE_ENV: 'test', RATE_LIMIT_STORE: 'REDIS' })], ['memory', 'redis']);

  const client = new Redis({ ...connection });
  const prefix = `t${Date.now()}`;
  const opts = { name: prefix, windowMs: 60_000, limit: 3 };

  console.log('\n--- 2) Redis deposu: iki AYRI "API örneği" aynı sayacı paylaşır');
  const a = await serve(makeLimiter(opts, { store: 'redis', client }));
  const b = await serve(makeLimiter(opts, { store: 'redis', client })); // ikinci süreç gibi
  const results = [await hit(a), await hit(b), await hit(a), await hit(b)];
  check('limit 3: 4. istek (örnek fark etmeksizin) 429', results, [200, 200, 200, 429]);
  check('429 gövdesi', await fetch(a.base + '/').then((r) => r.json()), { error: 'RATE_LIMITED', message: 'Çok fazla istek gönderildi, lütfen biraz sonra tekrar dene.' });

  console.log('\n--- 3) bellek deposu (karşılaştırma): örnekler sayaçları PAYLAŞMAZ');
  const m1 = await serve(makeLimiter({ ...opts, name: `${prefix}m` }, { store: 'memory' }));
  const m2 = await serve(makeLimiter({ ...opts, name: `${prefix}m` }, { store: 'memory' }));
  check('2+2 istek de geçer (limit fiilen ikiye katlanır — Redis\'in çözdüğü sorun)', [await hit(m1), await hit(m2), await hit(m1), await hit(m2)], [200, 200, 200, 200]);

  console.log('\n--- 4) farklı sınırlayıcılar sayaçları karıştırmaz (anahtar öneki)');
  const x = await serve(makeLimiter({ ...opts, name: `${prefix}x` }, { store: 'redis', client }));
  check('yeni önek: sayaç sıfırdan', await hit(x), 200);

  console.log('\n--- 5) Redis erişilemezse istek ENGELLENMEZ (fail-open)');
  const dead = new Redis({ host: '127.0.0.1', port: 1, enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
  dead.on('error', () => {});
  const d = await serve(makeLimiter({ ...opts, name: `${prefix}d` }, { store: 'redis', client: dead }));
  check('Redis yok: 10 istek de 200', await Promise.all(Array.from({ length: 10 }, () => hit(d))), Array(10).fill(200));

  for (const s of [a, b, m1, m2, x, d]) s.close();
  const keys = await client.keys(`rl:${prefix}*`);
  if (keys.length) await client.del(...keys);
  await client.quit();
  dead.disconnect();
  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
