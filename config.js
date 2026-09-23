// Geliştirme kolaylıklarının (kimliksiz premium ucu, fixture yedeği, secret'sız
// webhook) açık olup olmadığı TEK yerde karar verilir. Eskiden koşul
// "NODE_ENV !== 'production'" idi: değişken unutulunca ya da yanlış yazılınca
// ("prod", "Production") bunların hepsi canlıda sessizce açık kalıyordu. Şimdi
// fail-closed: yalnızca NODE_ENV AÇIKÇA 'development' ya da 'test' ise açık.
function isDevMode() {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

module.exports = { isDevMode };
