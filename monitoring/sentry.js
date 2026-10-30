// Hata izleme (Sentry). SENTRY_DSN yoksa TAMAMEN devre dışıdır: paket bile yüklenmez, tüm çağrılar no-op.
// Gizlilik: kişisel veri göndermiyoruz (sendDefaultPii kapalı) ve olaylar gönderilmeden önce temizlenir —
// kimlik başlıkları, istek gövdesi ve userId değerleri atılır/maskelenir (bkz. scrubEvent). Sentry kullanıyorsanız
// gizlilik politikası ve mağaza veri beyanları buna göre güncellenmeli.
const { scrubUrl } = require('../middleware/requestLog');

let sentry = null;

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];

// Sentry olayından kişisel/gizli verileri çıkarır. Sentry yüklü olmadan da test edilebilsin diye saf fonksiyon.
function scrubEvent(event) {
  if (!event) return event;
  if (event.request) {
    delete event.request.data; // istek gövdesi (URL'ler, jetonlar içerebilir)
    delete event.request.cookies;
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    if (typeof event.request.query_string === 'string') event.request.query_string = scrubUrl(`?${event.request.query_string}`).slice(1);
    if (event.request.headers) {
      for (const h of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.includes(h.toLowerCase())) delete event.request.headers[h];
      }
    }
  }
  delete event.user; // IP, kimlik vb.
  if (Array.isArray(event.breadcrumbs)) {
    for (const b of event.breadcrumbs) if (b?.data?.url) b.data.url = scrubUrl(b.data.url);
  }
  return event;
}

function initSentry(service) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || sentry) return Boolean(sentry);
  sentry = require('@sentry/node');
  sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0, // yalnızca hata izleme; performans izleme kapalı
    beforeSend: scrubEvent,
  });
  sentry.setTag('service', service);
  return true;
}

function captureError(err, context) {
  if (!sentry) return;
  sentry.captureException(err instanceof Error ? err : new Error(String(err)), context ? { extra: context } : undefined);
}

// level: 'error' | 'warning' | 'info'
function captureMessage(message, level = 'error', context) {
  if (!sentry) return;
  sentry.captureMessage(message, { level, extra: context });
}

// Süreç kapanmadan önce bekleyen olayları gönder.
async function flush(timeoutMs = 2000) {
  if (!sentry) return;
  try {
    await sentry.flush(timeoutMs);
  } catch {
    // kapanışı engelleme
  }
}

module.exports = { initSentry, captureError, captureMessage, flush, scrubEvent };
