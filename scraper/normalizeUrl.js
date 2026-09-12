// Bir takip hedefinin (aynı ürün+renk sayfası) "kimliğini" belirlemek için
// ham URL'i normalize eder. Amaç: aynı ürünü işaret eden farklı ham URL'leri
// (tracking parametreleri farklı, sıralaması farklı vb.) AYNI dedup
// anahtarına indirgemek — böylece 2 farklı kullanıcı aynı ürünü farklı
// query-string varyasyonlarıyla eklese bile tek bir trackedTarget'a
// düşerler (bkz. store/trackedTargetStore.js).
//
// pelement/v1/v2/ts/utm_* gibi parametreler İnditex/Mango sitelerinde
// içerik-etkisiz tracking/analytics id'leri olduğu gözlemlendi (bkz.
// mango.js, massimodutti.js yorumları) — dedup anahtarından çıkarılıyor.
// colorId/cS gibi parametreler İSE içeriği gerçekten değiştiriyor, o yüzden
// KORUNUYOR.
const NOISE_PARAMS = new Set([
  'pelement',
  'categoryid',
  'v1',
  'v2',
  'ts',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'gclid',
  'fbclid',
]);

function normalizeTrackingUrl(rawUrl) {
  const u = new URL(rawUrl);
  u.hash = '';
  const kept = [...u.searchParams.entries()]
    .filter(([key]) => !NOISE_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const search = kept.length
    ? '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';
  return `${u.origin.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${search}`;
}

module.exports = { normalizeTrackingUrl };
