// Expo Push API: Firebase/APNs projesi kurmadan push bildirim göndermenin
// en basit yolu. Mobil taraf expo-notifications ile bir "Expo push token"
// alıp bize kaydediyor; biz bu token'a mesaj gönderiyoruz, Expo'nun kendi
// altyapısı bunu arkada gerçek APNs/FCM'e yönlendiriyor.
// https://docs.expo.dev/push-notifications/sending-notifications/
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function isExpoPushToken(token) {
  return typeof token === 'string' && token.startsWith('ExponentPushToken');
}

async function sendExpoPush(tokens, { title, body, data }) {
  const validTokens = tokens.filter(isExpoPushToken);
  if (validTokens.length === 0) {
    return { sent: 0, skipped: tokens.length, reason: 'NO_VALID_TOKENS' };
  }

  const messages = validTokens.map((to) => ({ to, title, body, data, sound: 'default' }));

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    const json = await res.json();
    return { sent: validTokens.length, status: res.status, response: json };
  } catch (err) {
    return { sent: 0, error: err.message };
  }
}

module.exports = { sendExpoPush, isExpoPushToken, EXPO_PUSH_URL };
