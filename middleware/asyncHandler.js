// Express 4, async route handler'ların reddettiği promise'leri KENDİLİĞİNDEN
// yakalamıyor — handler içinde yakalanmamış bir `await` hatası, `next(err)`'e
// değil doğrudan Node'un unhandledRejection'ına düşer. Node 21'de bunun
// varsayılan sonucu process'in ÇÖKMESİ (bkz. server.js'deki
// process.on('unhandledRejection', ...) yorumu — aynı sınıf sorun
// queue/worker-process.js'de zaten fark edilip oradaki process için
// çözülmüştü, API process'inde eksikti). Her route'u bu sarmalayıcıyla
// tanımlamak, hatayı Express'in normal next(err) akışına (ve dolayısıyla
// server.js'deki global error handler'a) düşürüp process'i ayakta tutar.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
