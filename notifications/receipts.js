// Expo push TESLİMAT makbuzları. POST /send yalnızca "Expo isteği aldı" demektir (bilet); bildirimin APNs/FCM
// tarafından gerçekten kabul edilip edilmediği makbuzda görünür — özellikle Android'de FCM kimlik bilgisi
// eksik/yanlışsa (InvalidCredentials) HER bildirim sessizce düşer ve bunu yalnızca makbuz söyler.
// sendExpoPush bilet kimliklerini ~15 dk gecikmeli bir işe koyar (bkz. expoPush.js, queue/worker-process.js);
// bu modül o işin mantığıdır. https://docs.expo.dev/push-notifications/sending-notifications/#check-push-receipts-for-errors
const logger = require('../logger');
const deviceTokenStore = require('../store/deviceTokenStore');
const { captureMessage } = require('../monitoring/sentry');

const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const MAX_IDS_PER_REQUEST = 300;

// Bunlar bizim yapılandırma hatamız: kullanıcı jetonu değil, FCM/APNs kimlik bilgisi sorunlu. Hepsi tüm
// bildirimleri etkiler, bu yüzden error seviyesinde loglanır (izleme/uyarı buradan beslenir).
const CREDENTIAL_ERRORS = new Set(['InvalidCredentials', 'MismatchSenderId', 'InvalidProviderToken']);

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * @param {{id: string, token: string}[]} entries  bilet kimliği + hedef jeton
 * @returns {{ok:number, failed:number, removed:number, pending:{id:string,token:string}[]}}
 *   pending: makbuzu henüz hazır olmayanlar (Expo bazen 15 dakikadan uzun sürer) — çağıran yeniden dener.
 */
async function processReceipts(entries) {
  const result = { ok: 0, failed: 0, removed: 0, pending: [] };
  const tokenById = new Map(entries.map((e) => [e.id, e.token]));
  const unregistered = new Set();
  const credentialCodes = new Set();

  for (const batch of chunk(entries, MAX_IDS_PER_REQUEST)) {
    let receipts;
    try {
      const res = await fetch(RECEIPTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids: batch.map((e) => e.id) }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || typeof json.data !== 'object' || json.data === null) {
        logger.warn({ status: res.status }, '[push] makbuz isteği reddedildi');
        result.pending.push(...batch);
        continue;
      }
      receipts = json.data;
    } catch (err) {
      logger.warn({ err: err.message }, '[push] makbuzlara ulaşılamadı');
      result.pending.push(...batch);
      continue;
    }

    for (const entry of batch) {
      const receipt = receipts[entry.id];
      if (!receipt) {
        result.pending.push(entry);
        continue;
      }
      if (receipt.status === 'ok') {
        result.ok += 1;
        continue;
      }
      result.failed += 1;
      const code = receipt.details?.error;
      const fields = { code, message: receipt.message, token: `…${String(tokenById.get(entry.id)).slice(-6)}` };
      if (CREDENTIAL_ERRORS.has(code)) {
        credentialCodes.add(code);
        logger.error(fields, '[push] TESLİMAT HATASI: FCM/APNs kimlik bilgisi sorunlu — bildirimler ulaşmıyor (bkz. mobile/README.md)');
      } else {
        logger.warn(fields, '[push] bildirim teslim edilemedi');
      }
      if (code === 'DeviceNotRegistered') unregistered.add(entry.token);
    }
  }

  // FCM/APNs kimlik bilgisi hatası TÜM bildirimleri etkiler: koşu başına her hata türü için bir kez bildir.
  for (const code of credentialCodes) {
    captureMessage(`Push teslimat hatası: ${code} (FCM/APNs kimlik bilgisi)`, 'error', { code });
  }

  for (const token of unregistered) {
    try {
      result.removed += await deviceTokenStore.removeByToken(token);
    } catch (err) {
      logger.warn({ err: err.message }, '[push] geçersiz jeton silinemedi');
    }
  }
  return result;
}

module.exports = { processReceipts, RECEIPTS_URL, CREDENTIAL_ERRORS };
