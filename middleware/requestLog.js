const pinoHttp = require('pino-http');
const defaultLogger = require('../logger');

// Uygulamanın giriş sistemi yok: kimlik, cihazda üretilen rastgele bir UUID
// olan `userId` ve API'de TEK erişim anahtarı o (kimin takip listesini
// okuyabileceğini/silebileceğini bu belirliyor). O yüzden tam değeri
// adreslerde ve sorgu parametrelerinde log'a yazmıyoruz — log toplayıcıya
// erişen biri herkesin kimliğini toplayabilirdi. İlk 6 karakter, bir kullanıcının
// isteklerini birbirine bağlamaya yetiyor ama kimliğe bürünmeye yetmiyor.
function maskId(id) {
  let decoded = String(id);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* geçersiz kodlama: olduğu gibi maskele */
  }
  return decoded.length > 6 ? `${decoded.slice(0, 6)}***` : '***';
}

function scrubUrl(url) {
  if (typeof url !== 'string') return url;
  return url
    .replace(/([?&]userId=)([^&#\s]+)/gi, (_, prefix, id) => prefix + maskId(id))
    .replace(/(\/users\/)([^/?#\s]+)/gi, (_, prefix, id) => prefix + maskId(id));
}

function maskUserIdIn(record) {
  if (!record || typeof record !== 'object' || !('userId' in record)) return record;
  return { ...record, userId: maskId(record.userId) };
}

// Sağlık kontrolü (yük dengeleyici/konteyner her ~30sn çağırır) loglanmaz: günde binlerce
// anlamsız satır. Hata dönerse yine görünür (aşağıdaki seviye kuralı yalnızca ignore'u atlatır).
const SILENT_PATHS = new Set(['/api/health']);

function createRequestLogger(logger = defaultLogger) {
  return pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => SILENT_PATHS.has((req.url || '').split('?')[0]),
    },
    // 5xx hata, 4xx uyarı, geri kalanı bilgi: log toplayıcıda sorunlar süzülebilsin.
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    serializers: {
      // Yalnızca işe yarayanlar: eskiden TÜM istek başlıkları ve TÜM yanıt başlıkları (rate limit,
      // etag, cors...) her satıra yazılıyordu. Kimlik taşıyan başlıklar zaten hiç loglanmaz.
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: scrubUrl(req.url),
          query: maskUserIdIn(req.query),
          params: maskUserIdIn(req.params),
          // Vekil arkasında remoteAddress vekilin adresidir; gerçek istemci için Express'in req.ip'si
          // (trust proxy ayarına göre, bkz. config.js applyTrustProxy).
          ip: req.raw?.ip ?? req.remoteAddress,
          userAgent: req.headers?.['user-agent'],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  });
}

module.exports = { createRequestLogger, scrubUrl, maskId };
