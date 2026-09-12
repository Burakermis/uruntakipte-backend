const db = require('./db');

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    expoPushToken: row.expo_push_token,
    platform: row.platform,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

async function upsert({ userId, expoPushToken, platform }) {
  const { rows } = await db.query(
    `INSERT INTO device_tokens (user_id, expo_push_token, platform, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (expo_push_token) DO UPDATE
       SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()
     RETURNING *`,
    [userId, expoPushToken, platform ?? null]
  );
  return mapRow(rows[0]);
}

async function listByUser(userId) {
  const { rows } = await db.query('SELECT * FROM device_tokens WHERE user_id = $1', [userId]);
  return rows.map(mapRow);
}

module.exports = { upsert, listByUser };
