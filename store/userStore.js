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

async function isPremium(userId) {
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

module.exports = { getOrCreate, isPremium, setPremium };
