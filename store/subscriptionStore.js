const db = require('./db');

// Bir subscription "bir kullanıcının bir trackedTarget'ın belirli bir
// renk/beden'ine (sku) abone olması"dır. Fiyat/stok verisinin kendisi
// trackedTarget'ta tutulur (bkz. store/trackedTargetStore.js) — burada
// sadece KULLANICIYA ÖZGÜ olan şey saklanır: bildirim tercihleri ve "bu
// kullanıcı en son hangi fiyat/durumu gördü" (lastNotifiedPrice/
// lastNotifiedAvailability) — böylece aynı ürünü farklı zamanlarda takibe
// alan 2 kullanıcı, kendi başlangıç noktalarına göre doğru bildirim alır
// (bkz. checker.js'deki checkTrackedTarget).

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    targetId: row.target_id,
    sku: row.sku,
    active: row.active,
    notifyOnPriceDrop: row.notify_on_price_drop,
    notifyOnBackInStock: row.notify_on_back_in_stock,
    lastNotifiedPrice: row.last_notified_price != null ? Number(row.last_notified_price) : null,
    lastNotifiedAvailability: row.last_notified_availability,
    createdAt: row.created_at.toISOString(),
    removedAt: row.removed_at ? row.removed_at.toISOString() : null,
  };
}

async function findById(id) {
  const { rows } = await db.query('SELECT * FROM subscriptions WHERE id = $1', [Number(id)]);
  return mapRow(rows[0]);
}

// active filtrelemeden arar — silinmiş (pasif) bir abonelik varsa onu
// yeniden aktive edebilmek için (bkz. routes/products.js POST /).
async function findByUserTargetSku(userId, targetId, sku) {
  const { rows } = await db.query(
    'SELECT * FROM subscriptions WHERE user_id = $1 AND target_id = $2 AND sku = $3',
    [userId, Number(targetId), sku]
  );
  return mapRow(rows[0]);
}

async function create({ userId, targetId, sku, active = true, notifyOnPriceDrop, notifyOnBackInStock, lastNotifiedPrice, lastNotifiedAvailability }) {
  const { rows } = await db.query(
    `INSERT INTO subscriptions
       (user_id, target_id, sku, active, notify_on_price_drop, notify_on_back_in_stock, last_notified_price, last_notified_availability)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [userId, Number(targetId), sku, active, !!notifyOnPriceDrop, !!notifyOnBackInStock, lastNotifiedPrice ?? null, lastNotifiedAvailability ?? null]
  );
  return mapRow(rows[0]);
}

async function listByUser(userId) {
  const { rows } = await db.query('SELECT * FROM subscriptions WHERE user_id = $1 AND active = true', [userId]);
  return rows.map(mapRow);
}

// Worker'ın bir hedefi kontrol ettikten sonra bildirmesi gereken tüm
// kullanıcıları bulmak için.
async function listByTarget(targetId) {
  const { rows } = await db.query('SELECT * FROM subscriptions WHERE target_id = $1 AND active = true', [Number(targetId)]);
  return rows.map(mapRow);
}

async function countActiveByTarget(targetId) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM subscriptions WHERE target_id = $1 AND active = true', [Number(targetId)]);
  return rows[0].count;
}

// Ücretsiz/premium limiti ÜRÜN bazlı: aynı ürünün (target) farklı bedenleri
// tek slot sayılır — bu yüzden satır sayısı değil, DISTINCT target_id sayısı
// dönülüyor (bkz. routes/products.js'deki hasProductSlot mantığı).
async function countActiveByUser(userId) {
  const { rows } = await db.query(
    'SELECT COUNT(DISTINCT target_id)::int AS count FROM subscriptions WHERE user_id = $1 AND active = true',
    [userId]
  );
  return rows[0].count;
}

// Bu SKU değil, bu HEDEF için kullanıcının zaten aktif bir aboneliği var mı —
// aynı ürünün farklı bir bedenini eklerken yeni bir "slot" tüketmemesi
// gerektiğini belirlemek için (bkz. routes/products.js).
async function hasActiveSubscriptionForTarget(userId, targetId) {
  const { rows } = await db.query(
    'SELECT 1 FROM subscriptions WHERE user_id = $1 AND target_id = $2 AND active = true LIMIT 1',
    [userId, Number(targetId)]
  );
  return rows.length > 0;
}

// Ücretsiz plan "bir ürünü çıkarınca 48 saat bekle" kuralı için: bu
// kullanıcının en son NE ZAMAN bir abonelik sildiğini bulur (bkz.
// routes/products.js). Silinmemiş hiç kaydı yoksa null döner (bekleme yok).
async function lastRemovalAt(userId) {
  const { rows } = await db.query(
    `SELECT removed_at FROM subscriptions
     WHERE user_id = $1 AND active = false AND removed_at IS NOT NULL
     ORDER BY removed_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0]?.removed_at ? rows[0].removed_at.toISOString() : null;
}

const COLUMN_MAP = {
  active: 'active',
  notifyOnPriceDrop: 'notify_on_price_drop',
  notifyOnBackInStock: 'notify_on_back_in_stock',
  lastNotifiedPrice: 'last_notified_price',
  lastNotifiedAvailability: 'last_notified_availability',
  removedAt: 'removed_at',
};

async function update(id, patch) {
  const keys = Object.keys(patch).filter((k) => COLUMN_MAP[k]);
  if (keys.length === 0) return findById(id);
  const setClauses = keys.map((k, i) => `${COLUMN_MAP[k]} = $${i + 2}`);
  const values = keys.map((k) => patch[k]);
  const { rows } = await db.query(
    `UPDATE subscriptions SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [Number(id), ...values]
  );
  return mapRow(rows[0]);
}

// Soft delete: kayıt silinmez, `active:false` yapılır — kullanıcı aynı
// renk/bedeni tekrar takibe alırsa (findByUserTargetSku) geçmişiyle birlikte
// yeniden aktive edilir.
async function remove(id) {
  const { rows } = await db.query(
    `UPDATE subscriptions SET active = false, removed_at = now()
     WHERE id = $1 AND active = true
     RETURNING id`,
    [Number(id)]
  );
  return rows.length > 0;
}

module.exports = {
  findById,
  findByUserTargetSku,
  create,
  listByUser,
  listByTarget,
  countActiveByTarget,
  countActiveByUser,
  hasActiveSubscriptionForTarget,
  lastRemovalAt,
  update,
  remove,
};
