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

// Birden çok varyantı TEK sorguda yazar (variants: [{sku, price, availability}]).
// Eskiden varyant başına ayrı INSERT idi (12 varyantlı bir kontrol ~20 ms).
async function recordMany(targetId, variants) {
  if (variants.length === 0) return 0;
  await db.query(
    `INSERT INTO price_history (target_id, sku, price, availability)
     SELECT $1::int, sku, price, availability
     FROM unnest($2::text[], $3::numeric[], $4::text[]) AS t(sku, price, availability)`,
    [
      Number(targetId),
      variants.map((v) => v.sku),
      variants.map((v) => v.price ?? null),
      variants.map((v) => v.availability ?? null),
    ]
  );
  return variants.length;
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

// previousPrice'ın TOPLU hâli: Ürünlerim listesi her abonelik için ayrı sorgu
// atmasın (50 ürünlü bir kullanıcıda 50 gidiş-dönüş, havuzu dolduruyordu).
// pairs: [{targetId, sku, currentPrice}] -> Map("targetId|sku" -> önceki fiyat|null)
async function previousPrices(pairs) {
  if (pairs.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT p.target_id, p.sku,
            (SELECT price FROM (
               SELECT price, checked_at FROM price_history h
               WHERE h.target_id = p.target_id AND h.sku = p.sku
               ORDER BY checked_at DESC LIMIT 50
             ) recent
             WHERE price IS DISTINCT FROM p.current_price
             ORDER BY checked_at DESC LIMIT 1) AS previous
     FROM unnest($1::int[], $2::text[], $3::numeric[]) AS p(target_id, sku, current_price)`,
    [pairs.map((p) => Number(p.targetId)), pairs.map((p) => p.sku), pairs.map((p) => p.currentPrice ?? null)]
  );
  return new Map(rows.map((r) => [`${r.target_id}|${r.sku}`, r.previous != null ? Number(r.previous) : null]));
}

// olderThanDays günden eski, fiyat/durumu bir önceki kayıttan farklı OLMAYAN
// (yani "sıkıcı", tekrar bilgi taşımayan) ardışık kayıtları buda — asıl
// değişiklik noktaları (previousPrice'ın dayandığı kayıtlar) korunur.
// queue/worker-process.js günde bir çağırıyor; perf testleri de aynı SQL'i
// ölçüyor (perf/bench-history.js).
async function pruneUnchanged(olderThanDays = 90) {
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT id, target_id, sku, price,
              LAG(price) OVER (PARTITION BY target_id, sku ORDER BY checked_at) AS prev_price,
              checked_at
       FROM price_history
     )
     DELETE FROM price_history
     WHERE id IN (
       SELECT id FROM ranked
       WHERE checked_at < now() - ($1::int * INTERVAL '1 day')
         AND prev_price IS NOT DISTINCT FROM price
     )
     RETURNING id`,
    [olderThanDays]
  );
  return rows.length;
}

module.exports = { record, recordMany, listFor, previousPrice, previousPrices, pruneUnchanged };
