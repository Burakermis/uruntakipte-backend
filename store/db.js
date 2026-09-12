const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// JSON dosya deposundan Postgres'e geçiş (roadmap Faz 2) — arayüz artık
// senkron {data, save, nextId} değil, asenkron {query, migrate}. Her
// store/*.js modülü artık SQL sorgusu çalıştırıp sonucu kendi camelCase
// alan adlarına eşliyor (bkz. trackedTargetStore.js vb.).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://trackprice:trackprice@localhost:5433/trackprice',
});

function query(text, params) {
  return pool.query(text, params);
}

// Migration aracı yok (bu ölçekte gereksiz karmaşıklık) — schema.sql'deki
// CREATE TABLE IF NOT EXISTS ifadeleri idempotent, her açılışta çalıştırmak
// güvenli.
async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

module.exports = { pool, query, migrate };
