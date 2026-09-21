const db = require('./db');

// Bir trackedTarget "sayfası periyodik olarak çekilen tek bir ürün+renk
// URL'i"dir — kullanıcıdan bağımsızdır. `urlKeys` bir dizi çünkü aynı gerçek
// sayfa birden fazla ham URL biçimiyle işaret edilebiliyor (bkz.
// scraper/normalizeUrl.js'deki noise-param temizliği VE bazı markalarda
// -Massimo Dutti gibi- adaptörün kendi belirlediği canonicalUrl'in ham
// giriş URL'inden tamamen farklı olabilmesi); routes/products.js bu ikinci
// durumda ilk fetch'ten SONRA öğrendiği canonical anahtarı da alias olarak
// ekliyor ki bir sonraki istek fetch'siz bulsun.

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    urlKeys: row.url_keys,
    brand: row.brand,
    url: row.url,
    productId: row.product_id,
    name: row.name,
    imageUrl: row.image_url,
    canonicalUrl: row.canonical_url,
    variants: row.variants,
    consecutiveFailures: row.consecutive_failures,
    active: row.active,
    lastCheckedAt: row.last_checked_at ? row.last_checked_at.toISOString() : null,
    lastAttemptAt: row.last_attempt_at ? row.last_attempt_at.toISOString() : null,
    lastCheckStatus: row.last_check_status,
    createdAt: row.created_at.toISOString(),
  };
}

async function findByKey(urlKey) {
  const { rows } = await db.query('SELECT * FROM tracked_targets WHERE $1 = ANY(url_keys) LIMIT 1', [urlKey]);
  return mapRow(rows[0]);
}

async function findById(id) {
  const { rows } = await db.query('SELECT * FROM tracked_targets WHERE id = $1', [Number(id)]);
  return mapRow(rows[0]);
}

// Birden çok hedefi TEK sorguda getirir (id -> hedef Map'i).
async function findByIds(ids) {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query('SELECT * FROM tracked_targets WHERE id = ANY($1::int[])', [ids.map(Number)]);
  return new Map(rows.map((row) => [row.id, mapRow(row)]));
}

async function create({ urlKey, brand, url, productId, name, imageUrl, canonicalUrl, variants, lastCheckedAt, lastCheckStatus }) {
  const { rows } = await db.query(
    `INSERT INTO tracked_targets
       (url_keys, brand, url, product_id, name, image_url, canonical_url, variants, last_checked_at, last_check_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      [urlKey],
      brand ?? null,
      url ?? null,
      productId ?? null,
      name ?? null,
      imageUrl ?? null,
      canonicalUrl ?? null,
      JSON.stringify(variants ?? []),
      lastCheckedAt ?? null,
      lastCheckStatus ?? null,
    ]
  );
  return mapRow(rows[0]);
}

async function addAliasKey(id, urlKey) {
  const { rows } = await db.query(
    `UPDATE tracked_targets
     SET url_keys = CASE WHEN $2 = ANY(url_keys) THEN url_keys ELSE array_append(url_keys, $2) END
     WHERE id = $1
     RETURNING *`,
    [Number(id), urlKey]
  );
  return mapRow(rows[0]);
}

// Worker'ın periyodik taradığı liste.
async function listActive() {
  const { rows } = await db.query('SELECT * FROM tracked_targets WHERE active = true');
  return rows.map(mapRow);
}

const COLUMN_MAP = {
  brand: 'brand',
  url: 'url',
  productId: 'product_id',
  name: 'name',
  imageUrl: 'image_url',
  canonicalUrl: 'canonical_url',
  variants: 'variants',
  consecutiveFailures: 'consecutive_failures',
  active: 'active',
  lastCheckedAt: 'last_checked_at',
  lastAttemptAt: 'last_attempt_at',
  lastCheckStatus: 'last_check_status',
};

async function update(id, patch) {
  const keys = Object.keys(patch).filter((k) => COLUMN_MAP[k]);
  if (keys.length === 0) return findById(id);
  const setClauses = keys.map((k, i) => `${COLUMN_MAP[k]} = $${i + 2}`);
  const values = keys.map((k) => (k === 'variants' ? JSON.stringify(patch[k]) : patch[k]));
  const { rows } = await db.query(
    `UPDATE tracked_targets SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [Number(id), ...values]
  );
  return mapRow(rows[0]);
}

// Bir hedefin periyodik taramasını "sahiplenir": last_attempt_at, yalnızca hâlâ
// çağıranın okuduğu değerdeyse şimdiye çekilir ve true döner. Aynı hedef için
// eşzamanlı iki iş aynı eski değeri okuduysa YALNIZCA biri kazanır — "sırası
// geldi mi" kontrolü (checkSchedule.js) ile taramanın kendisi arasında
// saniyeler var ve last_attempt_at ancak tarama BİTİNCE yazılıyordu; bu
// yüzden birikmiş işler (worker durup kalkınca) aynı hedefi arka arkaya
// tarıyordu. Tek UPDATE olduğundan birden çok worker sürecinde de geçerli.
// date_trunc: JS tarafı milisaniye, Postgres mikrosaniye tutuyor — eşitlik
// karşılaştırması ondan etkilenmesin.
async function claimAttempt(target) {
  const { rows } = await db.query(
    `UPDATE tracked_targets SET last_attempt_at = $3
     WHERE id = $1 AND date_trunc('milliseconds', last_attempt_at) IS NOT DISTINCT FROM $2::timestamptz
     RETURNING id`,
    [Number(target.id), target.lastAttemptAt, new Date().toISOString()]
  );
  return rows.length > 0;
}

module.exports = { findByKey, findById, findByIds, create, addAliasKey, listActive, update, claimAttempt };
