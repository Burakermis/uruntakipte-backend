const { verifyToken } = require('../auth/token');
const userStore = require('../store/userStore');

function unauthorized(res) {
  return res.status(401).json({
    error: 'UNAUTHORIZED',
    message: 'Oturum doğrulanamadı. Uygulamayı yeniden başlatıp tekrar dene.',
  });
}

function forbidden(res) {
  return res.status(403).json({ error: 'FORBIDDEN', message: 'Bu kaynağa erişim iznin yok.' });
}

// İstekteki `Authorization: Bearer <token>` başlığını doğrular ve req.userId'ye
// yazar. Geçersiz/eksik token -> 401. Route'lar kimliği hâlâ gövde/sorgu/yoldaki
// `userId` ile alıyor; `matchUser` o değerin token'daki kimlikle aynı olmasını sağlar.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  const userId = match ? verifyToken(match[1]) : null;
  if (!userId) return unauthorized(res);
  try {
    // Silinen hesabın anahtarı hâlâ geçerli bir imzaya sahip: ayrıca reddedilir (401; istemci yeniden kaydolur).
    if (await userStore.isDeleted(userId)) return unauthorized(res);
  } catch (err) {
    return next(err);
  }
  req.userId = userId;
  return next();
}

// İstemcinin gövdede/sorguda gönderdiği userId token'dakinden farklıysa 403:
// geçerli bir token ile başkasının userId'si kullanılamasın. (Alan hiç yoksa
// route kendi 400 doğrulamasını yapar.)
function matchUser(req, res, next) {
  for (const supplied of [req.query?.userId, req.body?.userId]) {
    if (supplied !== undefined && supplied !== req.userId) return forbidden(res);
  }
  return next();
}

// router.param('userId', ...) için: yoldaki /:userId token'daki kimlikle aynı olmalı.
function matchUserParam(req, res, next, value) {
  if (value !== req.userId) return forbidden(res);
  return next();
}

module.exports = { requireAuth, matchUser, matchUserParam };
