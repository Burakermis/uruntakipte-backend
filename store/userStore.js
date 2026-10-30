const db = require('./db');

// Gerçek kimlik doğrulama/ödeme sistemi henüz yok — bu store sadece
// "userId -> premium mi" eşlemesini tutuyor. Görülmemiş bir userId ilk
// erişimde otomatik olarak ücretsiz (isPremium:false) plana kaydediliyor.

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    isPremium: row.is_premium,
    createdAt: row.created_at.toISOString(),
  };
}

async function getOrCreate(userId) {
  const { rows } = await db.query(
    `INSERT INTO users (user_id, is_premium) VALUES ($1, false)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [userId]
  );
  return mapRow(rows[0]);
}

// Önce SADECE OKUR. Eskiden her çağrı bir INSERT ... ON CONFLICT DO UPDATE
// idi: okuma uçları (GET /users/:id/limits) her seferinde bir yazma + fsync
// ödüyordu (tek istek 16 ms) ve `id SERIAL` kolonu çakışmada bile bir sayı
// tüketiyordu — sık çağrılırsa int4 sınırı aylar içinde dolar. Kayıt yalnızca
// kullanıcı İLK KEZ görüldüğünde açılır (getOrCreate'in eski sözleşmesi).
async function isPremium(userId) {
  const { rows } = await db.query('SELECT is_premium FROM users WHERE user_id = $1', [userId]);
  if (rows[0]) return rows[0].is_premium === true;
  const record = await getOrCreate(userId);
  return record.isPremium === true;
}

async function setPremium(userId, premium) {
  const { rows } = await db.query(
    `INSERT INTO users (user_id, is_premium) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET is_premium = EXCLUDED.is_premium
     RETURNING *`,
    [userId, !!premium]
  );
  return mapRow(rows[0]);
}

// Hesap silindi mi? (bkz. deleteAccount) — kimlik doğrulama her istekte sorar.
async function isDeleted(userId) {
  const { rowCount } = await db.query('SELECT 1 FROM deleted_users WHERE user_id = $1', [userId]);
  return rowCount > 0;
}

// Kullanıcının TÜM verisini tek işlemde siler: bildirim jetonları, tüm takipler (kaldırılmışlar dahil)
// ve kullanıcı kaydı; geriye yalnızca kimliğin kendisi (silindi işareti) kalır. Fiyat geçmişi ve takip
// edilen ürün kayıtları kullanıcıya ait değil (ürün bazında, paylaşımlı) — silinmez.
// İdempotent: hesap yoksa ya da zaten silinmişse de hata vermez.
async function deleteAccount(userId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const tokens = await client.query('DELETE FROM device_tokens WHERE user_id = $1', [userId]);
    const subs = await client.query('DELETE FROM subscriptions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE user_id = $1', [userId]);
    await client.query('INSERT INTO deleted_users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    await client.query('COMMIT');
    return { deviceTokens: tokens.rowCount, subscriptions: subs.rowCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getOrCreate, isPremium, setPremium, isDeleted, deleteAccount };
