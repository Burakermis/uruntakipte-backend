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

// Premium durumunu uygular ve ÖNCEKİ durumu bildirir. eventAtMs (olay zamanı) verilirse, kayıtlı son olaydan daha ESKİ bir
// olay durumu ezmez (applied:false): yeniden denemeler ve sıra karışması daha yeni bir EXPIRATION'ı eski bir RENEWAL ile
// geri almasın. eventAtMs yoksa (geliştirme ucu, testler) her zaman uygulanır ve olay zamanına dokunulmaz.
async function applyPremiumState(userId, premium, { eventAtMs = null } = {}) {
  return db.withTransaction(async (tx) => {
    const { rows } = await tx.query('SELECT is_premium, premium_event_at FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
    const prev = rows[0] || null;
    if (prev && eventAtMs != null && prev.premium_event_at && eventAtMs < prev.premium_event_at.getTime()) {
      return { applied: false, previous: prev.is_premium, current: prev.is_premium };
    }
    await tx.query(
      `INSERT INTO users (user_id, is_premium, premium_event_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         is_premium = EXCLUDED.is_premium,
         premium_event_at = GREATEST(users.premium_event_at, EXCLUDED.premium_event_at)`,
      [userId, !!premium, eventAtMs != null ? new Date(eventAtMs) : null]
    );
    return { applied: true, previous: prev ? prev.is_premium : null, current: !!premium };
  });
}

// Premium görünen ve doğrulaması `staleMs`'ten eski (ya da hiç yapılmamış) kullanıcılar, en eski doğrulama önce.
async function listPremiumDueForCheck(limit, staleMs) {
  const { rows } = await db.query(
    `SELECT user_id FROM users
     WHERE is_premium AND (premium_checked_at IS NULL OR premium_checked_at < now() - make_interval(secs => $2))
     ORDER BY premium_checked_at NULLS FIRST, id
     LIMIT $1`,
    [Number(limit), Number(staleMs) / 1000]
  );
  return rows.map((r) => r.user_id);
}

async function markPremiumChecked(userId) {
  await db.query('UPDATE users SET premium_checked_at = now() WHERE user_id = $1', [userId]);
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
    const notes = await client.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE user_id = $1', [userId]);
    await client.query('INSERT INTO deleted_users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    await client.query('COMMIT');
    return { deviceTokens: tokens.rowCount, subscriptions: subs.rowCount, notifications: notes.rowCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getOrCreate, isPremium, setPremium, applyPremiumState, listPremiumDueForCheck, markPremiumChecked, isDeleted, deleteAccount };
