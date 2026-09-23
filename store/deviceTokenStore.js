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

// Kayıt (kullanıcı, token) çiftine özel: aynı token başka bir userId ile gelirse
// mevcut kaydın sahibi DEĞİŞMEZ, ikinci bir kayıt eklenir. Eskiden çakışmada
// user_id üzerine yazılıyordu — token'ı bilen biri onu kendi kimliğine taşıyıp
// gerçek sahibinin bildirimlerini kesebiliyordu. Bedeli: uygulama yeniden
// kurulup userId değişince eski kimlik de aynı cihaza bildirim göndermeye
// devam eder (aynı kişi, zararsız); bunu kimliksiz bir API'de sahiplik
// kanıtı olmadan ayırt etmenin yolu yok.
async function upsert({ userId, expoPushToken, platform }) {
  const { rows } = await db.query(
    `INSERT INTO device_tokens (user_id, expo_push_token, platform, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, expo_push_token) DO UPDATE
       SET platform = EXCLUDED.platform, updated_at = now()
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
