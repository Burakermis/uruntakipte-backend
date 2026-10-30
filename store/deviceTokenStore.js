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

// Kullanıcı uygulamada bildirimleri kapattığında: bu kullanıcının tüm token kayıtları silinir,
// böylece checker.js'in bildirim gönderimi 'NO_DEVICE' ile atlanır. userId cihazda üretilen
// kimlik olduğundan (bir kurulum = bir userId) "bu cihazın bildirimleri" ile aynı şey.
// Silinecek kayıt yoksa da hata değil — çağrı idempotent (kapat, tekrar kapat → aynı sonuç).
async function removeByUser(userId) {
  const { rowCount } = await db.query('DELETE FROM device_tokens WHERE user_id = $1', [userId]);
  return rowCount;
}

// Expo "DeviceNotRegistered" dediği (uygulama silinmiş / bildirim izni kalkmış) bir jetonu, hangi
// kullanıcıya ait olursa olsun kaldırır — bir daha boşuna gönderim denenmez.
async function removeByToken(expoPushToken) {
  const { rowCount } = await db.query('DELETE FROM device_tokens WHERE expo_push_token = $1', [expoPushToken]);
  return rowCount;
}

module.exports = { upsert, listByUser, removeByUser, removeByToken };
