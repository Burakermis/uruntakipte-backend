// Migration çalıştırıcı (izole test DB'si gerekir). Gerçek schema_migrations tablosuna DOKUNMAZ: ayrı tablo + geçici klasör.
process.env.NODE_ENV = 'test';
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./store/db');
const { assertScratchDb, reset } = require('./perf/lib');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}
const TABLE = 'schema_migrations_t';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
const write = (name, sql) => fs.writeFileSync(path.join(dir, name), sql);
const exists = (t) => db.query('SELECT to_regclass($1) AS r', [t]).then((r) => r.rows[0].r !== null);

(async () => {
  assertScratchDb();
  await db.query(`DROP TABLE IF EXISTS ${TABLE}, mig_a, mig_b, mig_c`);

  console.log('--- 1) gerçek migration\'lar: baseline mevcut şemaya uygulanır, tekrar çalışmaz');
  await reset(); // db.migrate() (varsayılan klasör/tablo) çalıştırır ve tabloları boşaltır
  const real = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
  check('001_baseline.sql kaydedildi', real.includes('001_baseline.sql'), true);
  check('ikinci çağrı hiçbir şey uygulamaz', await db.migrate(), []);
  check('tablolar var (users, notifications, deleted_users)', await Promise.all(['users', 'notifications', 'deleted_users'].map(exists)), [true, true, true]);

  console.log('\n--- 2) sırayla uygula, yalnızca yenileri');
  write('001_a.sql', 'CREATE TABLE mig_a (id INT);\nSELECT 1;');
  write('002_b.sql', 'CREATE TABLE mig_b (id INT);');
  write('notamigration.txt', 'yok sayılır');
  check('iki dosya sırayla uygulandı', await db.migrate({ dir, table: TABLE }), ['001_a.sql', '002_b.sql']);
  check('tablolar oluştu', [await exists('mig_a'), await exists('mig_b')], [true, true]);
  check('tekrar: uygulanacak yok', await db.migrate({ dir, table: TABLE }), []);
  write('003_c.sql', 'CREATE TABLE mig_c (id INT);');
  check('yalnızca yeni dosya uygulanır', await db.migrate({ dir, table: TABLE }), ['003_c.sql']);

  console.log('\n--- 3) uygulanmış migration düzenlenirse açılış REDDEDİLİR (sağlama toplamı)');
  write('001_a.sql', 'CREATE TABLE mig_a (id INT, sonradan_eklenen TEXT);\nSELECT 1;');
  let err = null;
  await db.migrate({ dir, table: TABLE }).catch((e) => { err = e.message; });
  check('hata: migration değiştirilmiş', typeof err === 'string' && err.includes('Migration değiştirilmiş: 001_a.sql'), true);
  write('001_a.sql', 'CREATE TABLE mig_a (id INT);\nSELECT 1;'); // geri al
  check('geri alınınca yeniden çalışır', await db.migrate({ dir, table: TABLE }), []);
  write('001_a.sql', 'CREATE TABLE mig_a (id INT);\r\nSELECT 1;'); // yalnızca CRLF/LF farkı sağlama toplamını bozmaz
  check('satır sonu (CRLF) farkı sorun çıkarmaz', await db.migrate({ dir, table: TABLE }), []);

  console.log('\n--- 4) başarısız migration: işlem geri alınır, kaydedilmez, sonrakiler çalışmaz');
  write('004_bozuk.sql', 'CREATE TABLE mig_yarim (id INT); SELECT * FROM olmayan_tablo;');
  write('005_sonra.sql', 'CREATE TABLE mig_sonra (id INT);');
  err = null;
  await db.migrate({ dir, table: TABLE }).catch((e) => { err = e.message; });
  check('hata dosya adını söyler', typeof err === 'string' && err.startsWith('Migration başarısız (004_bozuk.sql)'), true);
  check('yarım kalan tablo GERİ ALINDI', await exists('mig_yarim'), false);
  check('bozuk migration kaydedilmedi, sonraki dosya çalışmadı', [(await db.query(`SELECT version FROM ${TABLE} WHERE version IN ('004_bozuk.sql','005_sonra.sql')`)).rowCount, await exists('mig_sonra')], [0, false]);
  fs.unlinkSync(path.join(dir, '004_bozuk.sql'));
  check('düzeltilince devam eder', await db.migrate({ dir, table: TABLE }), ['005_sonra.sql']);

  console.log('\n--- 5) eşzamanlı çalıştırma: advisory kilidi sayesinde TEK uygulama');
  write('006_yaris.sql', 'CREATE TABLE mig_yaris (id INT);');
  const results = await Promise.all([1, 2, 3, 4].map(() => db.migrate({ dir, table: TABLE })));
  check('4 süreçten yalnızca biri uyguladı (hata yok)', results.flat(), ['006_yaris.sql']);

  await db.query(`DROP TABLE IF EXISTS ${TABLE}, mig_a, mig_b, mig_c, mig_sonra, mig_yaris`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
