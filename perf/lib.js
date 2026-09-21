// Performans testleri için ortak yardımcılar. Testler GERÇEK store/route kodunu
// çalıştırır ama SENTETİK veriyle, izole bir veritabanında — asla canlı marka
// sitelerine istek atmaz (bkz. stub-fetch.js).
const path = require('path');

const db = require('../store/db');
const { normalizeTrackingUrl } = require('../scraper/normalizeUrl');

// Test tabloları TRUNCATE ediliyor: yanlışlıkla geliştirme veritabanına
// (varsayılan "trackprice") çalıştırılırsa veri kaybı olur. Bu yüzden ad
// açıkça bir test veritabanına benzemiyorsa hiçbir şey yapmıyoruz.
function assertScratchDb() {
  const url = process.env.DATABASE_URL || '';
  const name = (url.split('/').pop() || '').split('?')[0];
  if (!/(perf|e2e|test)/i.test(name)) {
    throw new Error(
      `Güvenlik: DATABASE_URL bir test veritabanına benzemiyor (${name || 'tanımsız'}). ` +
        `Adı perf/e2e/test içeren izole bir veritabanı kullan, ör. postgres://trackprice:trackprice@localhost:5433/trackprice_perf`
    );
  }
}

// Gerçek trafiğe yakın marka dağılımı (yüzde). H&M dahil hepsi.
const BRAND_MIX = [
  ['zara', 30],
  ['mango', 12],
  ['pullandbear', 12],
  ['bershka', 10],
  ['stradivarius', 10],
  ['hm', 10],
  ['massimodutti', 8],
  ['oysho', 8],
];

function urlFor(brand, i) {
  const n8 = String(10000000 + i);
  switch (brand) {
    case 'zara': return `https://www.zara.com/tr/tr/perf-${i}-p${n8}.html`;
    case 'hm': return `https://www2.hm.com/tr_tr/productpage.${String(1000000000 + i)}.html`;
    case 'pullandbear': return `https://www.pullandbear.com/tr/perf-${i}-l${n8}`;
    case 'bershka': return `https://www.bershka.com/tr/perf-${i}-c0p${String(200000000 + i)}.html`;
    case 'mango': return `https://shop.mango.com/tr/tr/p/erkek/gomlek/perf-${i}/${n8}/56/00`;
    case 'massimodutti': return `https://www.massimodutti.com/tr/perf-${i}-l${n8}`;
    case 'stradivarius': return `https://www.stradivarius.com/tr/perf-${i}-l${n8}`;
    case 'oysho': return `https://www.oysho.com/tr/perf-${i}-l${n8}`;
    default: throw new Error(`bilinmeyen marka ${brand}`);
  }
}

// n hedefe marka dağılımını uygular (yuvarlama artığı ilk markaya).
function brandsFor(n) {
  const list = [];
  for (const [brand, pct] of BRAND_MIX) {
    const count = Math.floor((n * pct) / 100);
    for (let k = 0; k < count; k++) list.push(brand);
  }
  while (list.length < n) list.push(BRAND_MIX[0][0]);
  // karıştır (sabit tohumlu basit LCG — sonuçlar tekrarlanabilir olsun)
  let seed = 12345;
  for (let i = list.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

async function reset() {
  assertScratchDb();
  await db.migrate();
  await db.query('TRUNCATE price_history, subscriptions, device_tokens, tracked_targets, users RESTART IDENTITY CASCADE');
}

async function seedUsers(n, premiumRatio = 0.3) {
  await db.query(
    `INSERT INTO users (user_id, is_premium)
     SELECT 'perf-u-' || g, (g % 100) < $2 FROM generate_series(1, $1) g
     ON CONFLICT (user_id) DO NOTHING`,
    [n, Math.round(premiumRatio * 100)]
  );
}

// Her hedefin tek bir varyantı (sku 'perf-sku') var; abonelikler buna bağlanıyor.
async function seedTargets(n, { lastAttemptAgoMs = 10 * 60 * 1000, brands = brandsFor(n) } = {}) {
  const urls = brands.map((b, i) => urlFor(b, i + 1));
  const keys = urls.map((u) => normalizeTrackingUrl(u));
  const variants = JSON.stringify([
    { sku: 'perf-sku', color: 'Siyah', size: 'M', price: 100, currency: 'TRY', availability: 'in_stock' },
  ]);
  await db.query(
    `INSERT INTO tracked_targets (url_keys, brand, url, product_id, name, canonical_url, variants, last_checked_at, last_attempt_at, last_check_status)
     SELECT ARRAY[k], b, u, 'perf-' || u, 'Perf ürün', u, $4::jsonb,
            now() - ($5::text || ' milliseconds')::interval, now() - ($5::text || ' milliseconds')::interval, 'ok'
     FROM unnest($1::text[], $2::text[], $3::text[]) AS t(k, b, u)`,
    [keys, brands, urls, variants, String(lastAttemptAgoMs)]
  );
}

// Her hedefe 1..maxSubs abone (id'ye göre DETERMİNİSTİK, ortalama (1+maxSubs)/2),
// kullanıcılar da id'den türetiliyor (aynı kullanıcı birçok hedefi izler).
async function seedSubscriptions(userCount, maxSubs = 3) {
  await db.query(
    `INSERT INTO subscriptions (user_id, target_id, sku, active, notify_on_price_drop, last_notified_price, last_notified_availability)
     SELECT 'perf-u-' || (1 + ((t.id * 7 + k * 13) % $1)), t.id, 'perf-sku', true, true, 100, 'in_stock'
     FROM tracked_targets t CROSS JOIN generate_series(1, $2) k
     WHERE k <= 1 + (t.id % $2)`,
    [userCount, maxSubs]
  );
}

// db.query'yi sarıp çalıştırdığı sorguları fiile göre sayar.
async function withQueryCount(fn) {
  const original = db.query;
  const byVerb = {};
  let queries = 0;
  db.query = (text, params) => {
    queries++;
    const verb = String(text).trim().split(/\s+/)[0].toUpperCase();
    byVerb[verb] = (byVerb[verb] || 0) + 1;
    return original(text, params);
  };
  try {
    const result = await fn();
    return { result, queries, byVerb };
  } finally {
    db.query = original;
  }
}

// pg_stat sayaçları asenkron yazılıyor — okumadan önce kısa bir bekleme.
async function tableTupleStats(table) {
  await new Promise((r) => setTimeout(r, 1500));
  const { rows } = await db.query(
    'SELECT n_tup_ins::bigint AS ins, n_tup_upd::bigint AS upd FROM pg_stat_user_tables WHERE relname = $1',
    [table]
  );
  return { ins: Number(rows[0].ins), upd: Number(rows[0].upd) };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s[s.length - 1] || 0 };
}

const round = (x, d = 0) => Number(x.toFixed(d));

module.exports = {
  db,
  assertScratchDb,
  BRAND_MIX,
  urlFor,
  brandsFor,
  reset,
  seedUsers,
  seedTargets,
  seedSubscriptions,
  withQueryCount,
  tableTupleStats,
  summarize,
  percentile,
  round,
  root: path.join(__dirname, '..'),
};
