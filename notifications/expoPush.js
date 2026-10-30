// Expo Push API: Firebase SDK'sı olmadan push bildirim göndermenin en basit yolu. Mobil taraf
// expo-notifications ile bir "Expo push token" alıp bize kaydediyor; biz bu token'a mesaj
// gönderiyoruz, Expo bunu arkada gerçek APNs (iOS) / FCM (Android) çağrısına çeviriyor.
// Android'de bunun çalışması için FCM V1 kimlik bilgisinin EAS'e yüklenmiş olması gerekir
// (bkz. mobile/README.md "Android bildirimleri").
// https://docs.expo.dev/push-notifications/sending-notifications/
const logger = require('../logger');
const deviceTokenStore = require('../store/deviceTokenStore');
const { receiptQueue, RECEIPT_DELAY_MS } = require('../queue/scrapeQueue');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Expo tek istekte en fazla 100 mesaj kabul ediyor.
const MAX_MESSAGES_PER_REQUEST = 100;

function isExpoPushToken(token) {
  return typeof token === 'string' && token.startsWith('ExponentPushToken');
}

// Jetonun tamamı loglanmaz (cihaza bildirim göndermeye yarar); son karakterler hata ayıklamaya yeter.
const tokenTail = (token) => `…${String(token).slice(-6)}`;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// POST /send hemen "bilet" (ticket) döner; hata varsa bilette görünür. Teslimat sonucu (ör. FCM
// kimlik bilgisi eksik: InvalidCredentials) ise yalnızca daha sonra alınan "makbuzda" çıkar —
// bkz. scripts/check-push.js.
async function sendExpoPush(tokens, { title, body, data }) {
  const validTokens = tokens.filter(isExpoPushToken);
  if (validTokens.length === 0) {
    return { sent: 0, failed: 0, removed: 0, skipped: tokens.length, reason: 'NO_VALID_TOKENS' };
  }

  const messages = validTokens.map((to) => ({ to, title, body, data, sound: 'default', channelId: 'default' }));
  const result = { sent: 0, failed: 0, removed: 0, skipped: tokens.length - validTokens.length, tickets: [] };
  const unregistered = [];

  for (const batch of chunk(messages, MAX_MESSAGES_PER_REQUEST)) {
    let json;
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      json = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(json?.data)) {
        result.failed += batch.length;
        logger.warn({ status: res.status, errors: json?.errors }, '[push] Expo isteği reddedildi');
        continue;
      }
    } catch (err) {
      result.failed += batch.length;
      logger.warn({ err: err.message }, '[push] Expo\'ya ulaşılamadı');
      continue;
    }

    json.data.forEach((ticket, i) => {
      if (ticket?.status === 'ok') {
        result.sent += 1;
        result.tickets.push({ id: ticket.id, token: batch[i]?.to });
        return;
      }
      result.failed += 1;
      const code = ticket?.details?.error;
      logger.warn({ token: tokenTail(batch[i]?.to), code, message: ticket?.message }, '[push] bildirim reddedildi');
      if (code === 'DeviceNotRegistered' && batch[i]) unregistered.push(batch[i].to);
    });
  }

  for (const token of unregistered) {
    try {
      result.removed += await deviceTokenStore.removeByToken(token);
    } catch (err) {
      logger.warn({ err: err.message }, '[push] geçersiz jeton silinemedi');
    }
  }
  // Teslimat makbuzları gecikmeli kontrol edilir (bkz. receipts.js). Kuyruk hatası gönderimi bozmaz.
  if (result.tickets.length > 0) {
    try {
      await receiptQueue.add('check-receipts', { entries: result.tickets }, { delay: RECEIPT_DELAY_MS });
    } catch (err) {
      logger.warn({ err: err.message }, '[push] makbuz kontrolü kuyruğa eklenemedi');
    }
  }
  if (unregistered.length > 0) {
    logger.info({ removed: result.removed }, '[push] kayıtsız cihaz jetonları silindi');
  }
  return result;
}

module.exports = { sendExpoPush, isExpoPushToken, EXPO_PUSH_URL };
