// Gerçek bir cihaza test bildirimi gönderir ve Expo'nun TESLİMAT makbuzunu okuyup sonucu açıklar.
// FCM/APNs kurulumunu doğrulamak içindir: bildirim isteği "ok" dönse bile (bilet), Android'de FCM
// kimlik bilgisi eksikse hata yalnızca makbuzda görünür.
//
// Kullanım:  node scripts/check-push.js "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"
// Jetonu almak için: uygulamayı açıp bildirime izin ver, sonra
//   docker exec uruntakipte-postgres-1 psql -U trackprice -d trackprice -c "select platform, expo_push_token from device_tokens order by id desc limit 5"
const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

const HINTS = {
  InvalidCredentials:
    'Android: FCM V1 kimlik bilgisi EAS\'e yüklenmemiş ya da yanlış projeye ait. expo.dev > proje > Credentials > Android > FCM V1 service account key. iOS: APNs anahtarı eksik.',
  MismatchSenderId:
    'Bu jeton başka bir Firebase projesiyle alınmış: google-services.json ile EAS\'e yüklenen service account AYNI Firebase projesinden olmalı. Uygulamayı yeniden derleyip jetonu yeniden al.',
  DeviceNotRegistered: 'Uygulama silinmiş ya da bildirim izni kalkmış. Jetonu yenile (uygulamayı açıp bildirimlere izin ver).',
  MessageRateExceeded: 'Çok sık gönderim; biraz bekleyip tekrar dene.',
  MessageTooBig: 'Bildirim içeriği çok büyük.',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

(async () => {
  const token = process.argv[2];
  if (!token || !token.startsWith('ExponentPushToken')) {
    console.error('Kullanım: node scripts/check-push.js "ExponentPushToken[...]"');
    process.exit(2);
  }

  const sent = await post(SEND_URL, [
    { to: token, title: 'ÜrünTakipte test', body: 'Bu bildirim bir kurulum denemesidir.', sound: 'default', channelId: 'default' },
  ]);
  const ticket = sent.json?.data?.[0];
  if (!ticket) {
    console.error('Expo isteği reddetti:', sent.status, JSON.stringify(sent.json));
    process.exit(1);
  }
  if (ticket.status !== 'ok') {
    const code = ticket.details?.error;
    console.error(`✘ Bilet reddedildi: ${code || ticket.message}\n  ${HINTS[code] || ticket.message}`);
    process.exit(1);
  }
  console.log(`Bilet kabul edildi (${ticket.id}). Teslimat makbuzu bekleniyor (en fazla ~90 sn)...`);

  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    const rec = (await post(RECEIPTS_URL, { ids: [ticket.id] })).json?.data?.[ticket.id];
    if (!rec) continue;
    if (rec.status === 'ok') {
      console.log('✔ Teslim edildi: Expo, bildirimi FCM/APNs\'e iletti. Telefonda göründüğünü kontrol et.');
      process.exit(0);
    }
    const code = rec.details?.error;
    console.error(`✘ Teslim edilemedi: ${code || rec.message}\n  ${HINTS[code] || rec.message}`);
    process.exit(1);
  }
  console.error('Makbuz henüz hazır değil (Expo bazen birkaç dakika sürebilir). Birkaç dakika sonra tekrar dene.');
  process.exit(3);
})().catch((err) => {
  console.error('Beklenmeyen hata:', err.message);
  process.exit(1);
});
