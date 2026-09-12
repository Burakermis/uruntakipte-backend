const pino = require('pino');

// Dağınık console.log/console.error yerine tek, yapılandırılmış (JSON)
// logger — prod'da bir log toplayıcıya (CloudWatch/Datadog/vb.) bağlanınca
// satır satır metin parse etmek yerine doğrudan sorgulanabilir alanlar
// (level, time, msg, ...ek context) üretir.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

module.exports = logger;
