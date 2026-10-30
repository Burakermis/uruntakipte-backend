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

module.exports = { isDevMode, assertProductionConfig };
