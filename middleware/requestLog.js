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

function createRequestLogger(logger = defaultLogger) {
  return pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { ...req, url: scrubUrl(req.url), query: maskUserIdIn(req.query), params: maskUserIdIn(req.params) };
      },
    },
  });
}

module.exports = { createRequestLogger, scrubUrl, maskId };
