const logger = require('../logger');
const notificationStore = require('../store/notificationStore');
const deviceTokenStore = require('../store/deviceTokenStore');
const { sendExpoPush } = require('./expoPush');

// Tek kullanıcıya bildirim: önce uygulama içi geçmişe yazar, sonra cihazlarına push yollar. Geçmiş push'tan BAĞIMSIZ
// yazılır (bildirimler kapalı olsa ya da cihaz kaydı olmasa da kullanıcı uygulamada ne olduğunu görebilsin); geçmiş
// yazılamazsa push engellenmez. `data`, push yüküne eklenir (uygulama bildirime dokunulunca yönlendirmek için).
async function notifyUser({ userId, type, title, body, productUrl, productName, imageUrl, data }) {
  try {
    await notificationStore.add({ userId, type, title, body, productUrl, productName, imageUrl });
  } catch (err) {
    logger.warn({ err: err.message, type }, '[notify] bildirim geçmişi yazılamadı');
  }

  const tokens = (await deviceTokenStore.listByUser(userId)).map((t) => t.expoPushToken);
  if (tokens.length === 0) return { sent: 0, reason: 'NO_DEVICE' };

  return sendExpoPush(tokens, { title, body, data: { ...data, type, url: productUrl } });
}

module.exports = { notifyUser };
