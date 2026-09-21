const pino = require('pino');

// Dağınık console.log/console.error yerine tek, yapılandırılmış (JSON)
// logger — prod'da bir log toplayıcıya (CloudWatch/Datadog/vb.) bağlanınca
// satır satır metin parse etmek yerine doğrudan sorgulanabilir alanlar
// (level, time, msg, ...ek context) üretir.
//
// Kimlik bilgisi taşıyan başlıklar log'a ASLA düz metin yazılmaz: pino-http
// (bkz. middleware/requestLog.js) her isteğin başlıklarını logluyor, yani
// RevenueCat webhook'unun `Authorization: Bearer <secret>` değeri — API'nin
// gizli anahtarı — her çağrıda log toplayıcıya gidiyordu (canlı testte log
// dosyasında düz metin olarak bulundu).
const loggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
};

const logger = pino(loggerOptions);

module.exports = logger;
module.exports.loggerOptions = loggerOptions; // testler aynı yapılandırmayla farklı bir hedefe yazabilsin
