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
async function findByUserTargetSku(userId, targetId, sku, q = db) {
  const { rows } = await q.query(
    'SELECT * FROM subscriptions WHERE user_id = $1 AND target_id = $2 AND sku = $3',
    [userId, Number(targetId), sku]
  );
  return mapRow(rows[0]);
}

// (user_id, target_id, sku) tekil (bkz. migration 004): aynı satır iki kez yaratılmaya çalışılırsa hata vermek yerine
// mevcut satır verilen değerlerle güncellenir, yani create idempotent. removed_at'e dokunulmaz.
async function create(
  { userId, targetId, sku, active = true, notifyOnPriceDrop, notifyOnBackInStock, lastNotifiedPrice, lastNotifiedAvailability },
  q = db
) {
  const { rows } = await q.query(
    `INSERT INTO subscriptions
       (user_id, target_id, sku, active, notify_on_price_drop, notify_on_back_in_stock, last_notified_price, last_notified_availability)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, target_id, sku) DO UPDATE SET
       active = EXCLUDED.active,
       notify_on_price_drop = EXCLUDED.notify_on_price_drop,
       notify_on_back_in_stock = EXCLUDED.notify_on_back_in_stock,
       last_notified_price = EXCLUDED.last_notified_price,
       last_notified_availability = EXCLUDED.last_notified_availability
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

// Hedef başına "aktif abonelerinden biri premium mu" — tek SORGU, SALT OKUMA.
// Eskiden checkSchedule her hedef için listByTarget + her abone için
// userStore.isPremium çağırıyordu ve isPremium her çağrıda bir UPSERT
// (yazma) yapıyordu: 8.000 hedefte her dakika 24.000 sorgu ve ~15.000 users
// satırı güncellemesi, üstelik tik boyunca DB havuzu dolu kaldığı için API
// istekleri saniyelerce bekliyordu (bkz. perf/bench-tick.js, bench-api.js).
// targetIds verilmezse TÜM hedefler. Aktif abonesi olmayan hedef haritada YOK.
// users satırı olmayan kullanıcı ücretsiz sayılır (isPremium ile aynı sonuç).
async function premiumByTarget(targetIds = null) {
  const { rows } = await db.query(
    `SELECT s.target_id, COALESCE(bool_or(u.is_premium), false) AS any_premium
     FROM subscriptions s LEFT JOIN users u ON u.user_id = s.user_id
     WHERE s.active = true AND ($1::int[] IS NULL OR s.target_id = ANY($1::int[]))
     GROUP BY s.target_id`,
    [targetIds ? targetIds.map(Number) : null]
  );
  return new Map(rows.map((r) => [r.target_id, r.any_premium]));
}

// Kullanıcının aktif ürünleri (hedef kimlikleri), en eski takibe alınandan başlayarak (bkz. billing/plan.js).
async function listActiveTargetIdsOldestFirst(userId, q = db) {
  const { rows } = await q.query(
    `SELECT target_id FROM subscriptions WHERE user_id = $1 AND active = true
     GROUP BY target_id ORDER BY min(created_at), target_id`,
    [userId]
  );
  return rows.map((r) => r.target_id);
}

// Sistem tarafından kapatma (plan sınırı): removed_at YAZILMAZ, yani ücretsiz plandaki bekleme süresini tetiklemez.
async function deactivateTargets(userId, targetIds, q = db) {
  const { rowCount } = await q.query(
    'UPDATE subscriptions SET active = false WHERE user_id = $1 AND active = true AND target_id = ANY($2::int[])',
    [userId, targetIds.map(Number)]
  );
  return rowCount;
}

async function countActiveByTarget(targetId) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM subscriptions WHERE target_id = $1 AND active = true', [Number(targetId)]);
  return rows[0].count;
}

// Ücretsiz/premium limiti ÜRÜN bazlı: aynı ürünün (target) farklı bedenleri
// tek slot sayılır — bu yüzden satır sayısı değil, DISTINCT target_id sayısı
// dönülüyor (bkz. routes/products.js'deki hasProductSlot mantığı).
async function countActiveByUser(userId, q = db) {
  const { rows } = await q.query(
    'SELECT COUNT(DISTINCT target_id)::int AS count FROM subscriptions WHERE user_id = $1 AND active = true',
    [userId]
  );
  return rows[0].count;
}

// Bu SKU değil, bu HEDEF için kullanıcının zaten aktif bir aboneliği var mı —
// aynı ürünün farklı bir bedenini eklerken yeni bir "slot" tüketmemesi
// gerektiğini belirlemek için (bkz. routes/products.js).
async function hasActiveSubscriptionForTarget(userId, targetId, q = db) {
  const { rows } = await q.query(
    'SELECT 1 FROM subscriptions WHERE user_id = $1 AND target_id = $2 AND active = true LIMIT 1',
    [userId, Number(targetId)]
  );
  return rows.length > 0;
}

// Ücretsiz plan "bir ürünü çıkarınca 48 saat bekle" kuralı için: bu
// kullanıcının en son NE ZAMAN bir abonelik sildiğini bulur (bkz.
// routes/products.js). Silinmemiş hiç kaydı yoksa null döner (bekleme yok).
async function lastRemovalAt(userId, q = db) {
  const { rows } = await q.query(
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

async function update(id, patch, q = db) {
  const keys = Object.keys(patch).filter((k) => COLUMN_MAP[k]);
  if (keys.length === 0) return findById(id);
  const setClauses = keys.map((k, i) => `${COLUMN_MAP[k]} = $${i + 2}`);
  const values = keys.map((k) => patch[k]);
  const { rows } = await q.query(
    `UPDATE subscriptions SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [Number(id), ...values]
  );
  return mapRow(rows[0]);
}

// Soft delete: kayıt silinmez, `active:false` yapılır — kullanıcı aynı
// renk/bedeni tekrar takibe alırsa (findByUserTargetSku) geçmişiyle birlikte
// yeniden aktive edilir.
async function remove(id, q = db) {
  const { rows } = await q.query(
    `UPDATE subscriptions SET active = false, removed_at = now()
     WHERE id = $1 AND active = true
     RETURNING id`,
    [Number(id)]
  );
  return rows.length > 0;
}

// Bir kullanıcının abonelik DEĞİŞTİREN işlemlerini (ekle/çıkar) sıraya sokar: "limit/bekleme kontrolü + yazma" iki ayrı
// adım olduğundan, kilitsiz eşzamanlı istekler aynı eski sayıyı okuyup limiti aşıyordu (ücretsiz plan 3 yerine 8 ürün).
// Kilit işlem boyuncadır (pg_advisory_xact_lock) ve kullanıcıya özeldir; başka kullanıcıları ve okuma uçlarını bekletmez,
// birden çok API sürecinde de geçerlidir. fn(tx) içinde YALNIZCA tx.query kullanılmalı (bkz. db.withTransaction).
// 5 sn içinde alınamazsa 55P03 (lock_timeout) fırlatır; çağıran 503 döner.
const USER_LOCK_NAMESPACE = 727275; // migration kilidinden (727274) ayrı bir alan
function withUserLock(userId, fn) {
  return db.withTransaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [USER_LOCK_NAMESPACE, userId]);
    return fn(tx);
  });
}

module.exports = {
  withUserLock,
  listActiveTargetIdsOldestFirst,
  deactivateTargets,
  findById,
  findByUserTargetSku,
  create,
  listByUser,
  listByTarget,
  premiumByTarget,
  countActiveByTarget,
  countActiveByUser,
  hasActiveSubscriptionForTarget,
  lastRemovalAt,
  update,
  remove,
};
