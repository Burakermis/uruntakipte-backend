const crypto = require('crypto');
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

// Tek bir bağlantıda BEGIN..COMMIT çalıştırır; fn(tx) içindeki TÜM sorgular tx.query ile aynı bağlantıdan gitmeli
// (havuzdan ikinci bağlantı almak, havuz doluyken kendi kendini kilitleyebilir). Hata olursa ROLLBACK.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Sürümlü migration'lar: store/migrations/NNN_ad.sql dosyaları sırayla, her biri TEK işlemde uygulanır ve
// schema_migrations tablosuna yazılır; uygulanmış olanlar bir daha çalışmaz. Yeni şema değişikliği = yeni dosya
// (002_..., 003_...); uygulanmış bir dosya ASLA düzenlenmez (içeriği değişirse sağlama toplamı uyuşmaz ve açılış hata
// verir — canlı veritabanının hangi şemada olduğu belirsiz kalmasın). 001_baseline.sql eski schema.sql'in birebir
// halidir ve idempotent (IF NOT EXISTS) yazıldığı için ilk çalıştığında mevcut veritabanlarına zarar vermez.
// Aynı anda birden çok süreç (API + worker + ölçekleme) açılırsa tek biri uygular: Postgres advisory kilidi.
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_LOCK_KEY = 727274;

async function migrate({ dir = MIGRATIONS_DIR, table = 'schema_migrations' } = {}) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    );
    const done = new Map((await client.query(`SELECT version, checksum FROM ${table}`)).rows.map((r) => [r.version, r.checksum]));
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      if (done.has(file)) {
        if (done.get(file) !== checksum) {
          throw new Error(`Migration değiştirilmiş: ${file} uygulandıktan sonra düzenlenmiş. Değişikliği YENİ bir migration dosyasına yazın.`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`INSERT INTO ${table} (version, checksum) VALUES ($1, $2)`, [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `Migration başarısız (${file}): ${err.message}`;
        throw err;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { pool, query, withTransaction, migrate, MIGRATIONS_DIR };
