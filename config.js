// Geliştirme kolaylıklarının (kimliksiz premium ucu, fixture yedeği, secret'sız
// webhook) açık olup olmadığı TEK yerde karar verilir. Eskiden koşul
// "NODE_ENV !== 'production'" idi: değişken unutulunca ya da yanlış yazılınca
// ("prod", "Production") bunların hepsi canlıda sessizce açık kalıyordu. Şimdi
// fail-closed: yalnızca NODE_ENV AÇIKÇA 'development' ya da 'test' ise açık.
function isDevMode() {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

// Canlıda bilinen geliştirme parolasıyla (docker-compose.yml'deki `trackprice`) çalışmayı
// reddeder: veritabanı yanlışlıkla ağa açılırsa herkesin girebileceği bir parola olurdu.
// Her iki süreç (API ve worker) açılışta çağırır.
function assertProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  let password = '';
  try {
    password = decodeURIComponent(new URL(process.env.DATABASE_URL || '').password);
  } catch {
    // DATABASE_URL yok/bozuk: bağlantı zaten kurulamaz, ayrıca şikâyet etmeye gerek yok.
  }
  if (password === 'trackprice') {
    throw new Error('DATABASE_URL varsayılan geliştirme parolasını (trackprice) kullanıyor. Canlıda POSTGRES_PASSWORD ile güçlü bir parola verin.');
  }
}

// Ters vekil (nginx/Caddy/yük dengeleyici) arkasında Express bağlantının IP'sini vekilin adresi
// sanır; hız sınırı da herkesi TEK istemci sayıp ilk kullanıcıdan sonra hepsini keserdi.
// TRUST_PROXY = istek ile uygulama arasındaki GÜVENİLİR vekil sayısı (ör. tek vekil için 1).
// Bilerek sadece sayı kabul edilir: `true` her X-Forwarded-For başlığına güvenir ve istemci
// kendi IP'sini uydurarak hız sınırını aşar. Tanımsız/0 = vekil yok (başlıklar yok sayılır).
function trustProxyHops(value = process.env.TRUST_PROXY) {
  if (value === undefined || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    throw new Error(`TRUST_PROXY geçersiz ("${value}"): güvenilen vekil sayısını (0-10 arası tam sayı) verin; "true" kabul edilmez.`);
  }
  return n;
}

function applyTrustProxy(app, value) {
  const hops = trustProxyHops(value);
  app.set('trust proxy', hops === 0 ? false : hops);
  return hops;
}

module.exports = { isDevMode, assertProductionConfig, trustProxyHops, applyTrustProxy };
