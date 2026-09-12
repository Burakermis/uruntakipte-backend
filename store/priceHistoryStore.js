const db = require('./db');

// Fiyat geçmişi artık kullanıcı bazlı değil, HEDEF+sku bazlı: aynı ürünü
// izleyen N kullanıcı olsa da her kontrol turunda tek bir geçmiş kaydı
// yazılır (bkz. checker.js). Bu hem depoyu şişirmez hem de "gerçek fiyat
// geçmişi" ürünün kendisine ait bir şey olduğu için daha doğru bir modeldir.

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    targetId: row.target_id,
    sku: row.sku,
    price: row.price != null ? Number(row.price) : null,
    availability: row.availability,
    checkedAt: row.checked_at.toISOString(),
  };
}

async function record({ targetId, sku, price, availability }) {
  const { rows } = await db.query(
    `INSERT INTO price_history (target_id, sku, price, availability)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [Number(targetId), sku, price ?? null, availability ?? null]
  );
  return mapRow(rows[0]);
}

// Bir hedef+sku için en yeniden en eskiye kayıtlar.
async function listFor(targetId, sku, limit = 30) {
  const { rows } = await db.query(
    `SELECT * FROM price_history WHERE target_id = $1 AND sku = $2 ORDER BY checked_at DESC LIMIT $3`,
    [Number(targetId), sku, limit]
  );
  return rows.map(mapRow);
}

// Ürünlerim listesindeki "%5 düştü" rozeti için karşılaştırma noktası.
// Basitçe "bir önceki kayıt" değil, şu anki fiyattan FARKLI olan en son kayıt
// aranır — aksi halde art arda değişmeyen kontroller (worker turu + manuel
// "şimdi kontrol et") araya girdiğinde asıl değişikliğin kaydı "bir önceki"
// konumundan kayar ve rozet gerçek bir değişiklik olmasa bile sıfırlanır.
async function previousPrice(targetId, sku, currentPrice) {
  const { rows } = await db.query(
    `SELECT price FROM (
       SELECT price, checked_at FROM price_history WHERE target_id = $1 AND sku = $2
       ORDER BY checked_at DESC LIMIT 50
     ) recent
     WHERE price IS DISTINCT FROM $3
     ORDER BY checked_at DESC LIMIT 1`,
    [Number(targetId), sku, currentPrice]
  );
  return rows[0]?.price != null ? Number(rows[0].price) : null;
}

module.exports = { record, listFor, previousPrice };
