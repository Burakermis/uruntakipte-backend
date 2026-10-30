const db = require('./db');
const { NOTIFICATION_RETENTION_DAYS, NOTIFICATION_MAX_PER_USER } = require('../constants');

// Bildirim geçmişi: kullanıcıya gönderilen (ya da gönderilecek olan) fiyat/stok bildirimlerinin kısa
// süreli kaydı — uygulamadaki "Bildirim Geçmişi" ekranı bunu gösterir. Bilerek KISA ömürlü ve sınırlı:
//   - NOTIFICATION_RETENTION_DAYS günden eski kayıtlar günlük temizlik işiyle silinir (bkz. pruneOlderThan),
//   - kullanıcı başına en fazla NOTIFICATION_MAX_PER_USER kayıt tutulur (her eklemede eskiler budanır),
//   - hesap silinince hepsi silinir (bkz. userStore.deleteAccount).
// Böylece tablo sınırsız büyümez ve gereğinden uzun kişisel veri saklanmaz.

function mapRow(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    productUrl: row.product_url,
    productName: row.product_name,
    imageUrl: row.image_url,
    createdAt: row.created_at.toISOString(),
  };
}

async function add({ userId, type, title, body, productUrl, productName, imageUrl }) {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, type, title, body, product_url, product_name, image_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, type, title, body, productUrl ?? null, productName ?? null, imageUrl ?? null]
  );
  // Kullanıcı başına üst sınır: en yeni N kaydı tut (indeks: user_id, created_at DESC).
  await db.query(
    `DELETE FROM notifications
     WHERE user_id = $1 AND id NOT IN (
       SELECT id FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
     )`,
    [userId, NOTIFICATION_MAX_PER_USER]
  );
  return mapRow(rows[0]);
}

async function listByUser(userId, limit = 50) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), NOTIFICATION_MAX_PER_USER);
  const { rows } = await db.query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [userId, capped]
  );
  return rows.map(mapRow);
}

async function removeByUser(userId) {
  const { rowCount } = await db.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
  return rowCount;
}

// Günlük temizlik işi (queue/worker-process.js) çağırır.
async function pruneOlderThan(days = NOTIFICATION_RETENTION_DAYS) {
  const { rowCount } = await db.query(
    `DELETE FROM notifications WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return rowCount;
}

module.exports = { add, listByUser, removeByUser, pruneOlderThan };
