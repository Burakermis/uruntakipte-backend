// Push gönderimi (notifications/expoPush.js): Expo yanıtları sahte; canlıya istek atılmaz.
// İzole test DB'si gerekir (perf/lib.js koruması). Eskiden yanıt hiç incelenmiyordu: hatalı
// bilet, kayıtsız cihaz ve reddedilen istek sessizce kaybolurdu.
process.env.NODE_ENV = 'test';
const { db, reset } = require('./perf/lib');
const deviceTokenStore = require('./store/deviceTokenStore');
// Makbuz işi Redis'e GERÇEKTEN eklenmesin (geliştirme Redis'inde gecikmeli iş kalmasın): kuyruk sahte.
const queues = require('./queue/scrapeQueue');
const receiptJobs = [];
queues.receiptQueue.add = async (name, data, opts) => { receiptJobs.push({ name, data, opts }); };
const { sendExpoPush } = require('./notifications/expoPush');
const { processReceipts } = require('./notifications/receipts');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}

const realFetch = global.fetch;
const requests = [];
let handler;
global.fetch = async (url, init) => {
  const batch = JSON.parse(init.body);
  requests.push(batch);
  const out = await handler(batch);
  return { ok: out.status === undefined || out.status < 400, status: out.status ?? 200, json: async () => out.body };
};
const payload = { title: 'T', body: 'B', data: { x: 1 } };
const tok = (n) => `ExponentPushToken[${String(n).padStart(6, '0')}]`;

(async () => {
  await reset();

  console.log('--- 1) tümü başarılı');
  handler = (batch) => ({ body: { data: batch.map((_, i) => ({ status: 'ok', id: `t${i}` })) } });
  let r = await sendExpoPush([tok(1), tok(2)], payload);
  check('2 bilet kabul', [r.sent, r.failed, r.removed], [2, 0, 0]);
  check('mesaj biçimi: kanal + ses + veri', [requests[0][0].channelId, requests[0][0].sound, requests[0][0].data], ['default', 'default', { x: 1 }]);
  check('bilet kimlikleri jetonlarıyla dönüyor', r.tickets, [{ id: 't0', token: tok(1) }, { id: 't1', token: tok(2) }]);
  check('teslimat makbuzu kontrolü ~15 dk GECİKMELİ kuyruğa eklendi', [receiptJobs.length, receiptJobs[0].name, receiptJobs[0].opts.delay, receiptJobs[0].data.entries.length], [1, 'check-receipts', 15 * 60 * 1000, 2]);

  console.log('\n--- 2) geçersiz jetonlar hiç gönderilmez');
  requests.length = 0;
  r = await sendExpoPush(['abc', null, tok(3)], payload);
  check('yalnızca geçerli jeton gitti', requests[0].map((m) => m.to), [tok(3)]);
  check('atlanan sayısı', r.skipped, 2);
  requests.length = 0;
  r = await sendExpoPush(['abc'], payload);
  check('hiç geçerli jeton yok -> istek atılmaz', [requests.length, r.reason], [0, 'NO_VALID_TOKENS']);

  console.log('\n--- 3) DeviceNotRegistered: jeton DB\'den silinir, diğerleri kalır');
  await deviceTokenStore.upsert({ userId: 'u1', expoPushToken: tok(10), platform: 'android' });
  await deviceTokenStore.upsert({ userId: 'u1', expoPushToken: tok(11), platform: 'ios' });
  handler = () => ({
    body: {
      data: [
        { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
        { status: 'ok', id: 'ok1' },
      ],
    },
  });
  r = await sendExpoPush([tok(10), tok(11)], payload);
  check('1 kabul, 1 reddedildi, 1 jeton silindi', [r.sent, r.failed, r.removed], [1, 1, 1]);
  check('kayıtsız jeton silindi, sağlam olan duruyor', (await deviceTokenStore.listByUser('u1')).map((t) => t.expoPushToken), [tok(11)]);

  console.log('\n--- 4) diğer bilet hataları jetonu SİLMEZ (ör. FCM kimlik bilgisi/geçici hata)');
  handler = () => ({ body: { data: [{ status: 'error', message: 'x', details: { error: 'MessageRateExceeded' } }] } });
  r = await sendExpoPush([tok(11)], payload);
  check('reddedildi ama silinmedi', [r.failed, r.removed, (await deviceTokenStore.listByUser('u1')).length], [1, 0, 1]);

  console.log('\n--- 5) Expo isteği reddederse / ulaşılamazsa süreç patlamaz');
  handler = () => ({ status: 400, body: { errors: [{ code: 'VALIDATION_ERROR' }] } });
  r = await sendExpoPush([tok(1), tok(2)], payload);
  check('400 -> hepsi başarısız sayılır', [r.sent, r.failed], [0, 2]);
  handler = () => ({ status: 200, body: { unexpected: true } });
  r = await sendExpoPush([tok(1)], payload);
  check('beklenmeyen gövde -> başarısız sayılır', [r.sent, r.failed], [0, 1]);
  handler = () => { throw new TypeError('network'); };
  r = await sendExpoPush([tok(1)], payload);
  check('ağ hatası -> başarısız, istisna yok', [r.sent, r.failed], [0, 1]);

  console.log('\n--- 6) 100\'den fazla mesaj 100\'lük gruplara bölünür (Expo sınırı)');
  requests.length = 0;
  handler = (batch) => ({ body: { data: batch.map((_, i) => ({ status: 'ok', id: String(i) })) } });
  r = await sendExpoPush(Array.from({ length: 250 }, (_, i) => tok(100 + i)), payload);
  check('3 istek: 100+100+50', requests.map((b) => b.length), [100, 100, 50]);
  check('hepsi kabul', r.sent, 250);

  console.log('\n--- 7) makbuz kuyruğu: biletsiz gönderimde iş eklenmez; kuyruk hatası gönderimi bozmaz');
  receiptJobs.length = 0;
  handler = () => ({ body: { data: [{ status: 'error', message: 'x', details: { error: 'MessageRateExceeded' } }] } });
  await sendExpoPush([tok(1)], payload);
  check('kabul edilen bilet yok -> makbuz işi yok', receiptJobs.length, 0);
  handler = (batch) => ({ body: { data: batch.map((_, i) => ({ status: 'ok', id: `q${i}` })) } });
  queues.receiptQueue.add = async () => { throw new Error('redis kapalı'); };
  r = await sendExpoPush([tok(1)], payload);
  check('kuyruk hatası -> gönderim yine başarılı', [r.sent, r.failed], [1, 0]);

  console.log('\n--- 8) teslimat makbuzları (receipts.js)');
  await deviceTokenStore.upsert({ userId: 'u9', expoPushToken: tok(90), platform: 'android' });
  await deviceTokenStore.upsert({ userId: 'u9', expoPushToken: tok(91), platform: 'ios' });
  const entries = [
    { id: 'r-ok', token: tok(91) },
    { id: 'r-gone', token: tok(90) },
    { id: 'r-cred', token: tok(92) },
    { id: 'r-late', token: tok(93) },
  ];
  const receiptRequests = [];
  handler = (body) => {
    receiptRequests.push(body);
    return {
      body: {
        data: {
          'r-ok': { status: 'ok' },
          'r-gone': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
          'r-cred': { status: 'error', message: 'FCM credentials', details: { error: 'InvalidCredentials' } },
          // 'r-late' henüz hazır değil: yanıtta yok
        },
      },
    };
  };
  const rec = await processReceipts(entries);
  check('1 ok, 2 hata (kayıtsız cihaz + kimlik bilgisi), 1 henüz hazır değil', [rec.ok, rec.failed, rec.pending.map((e) => e.id)], [1, 2, ['r-late']]);
  check('yalnızca DeviceNotRegistered jetonu silinir (kimlik bilgisi hatası jetonu SİLMEZ)', [rec.removed, (await deviceTokenStore.listByUser('u9')).map((t) => t.expoPushToken)], [1, [tok(91)]]);
  check('makbuz isteği kimlikleri tek istekte gönderir', receiptRequests[0].ids, ['r-ok', 'r-gone', 'r-cred', 'r-late']);

  handler = () => ({ status: 500, body: {} });
  const down = await processReceipts([{ id: 'a', token: tok(1) }]);
  check('Expo hatası -> hepsi bekleyen (yeniden denenir), istisna yok', [down.ok, down.failed, down.pending.length], [0, 0, 1]);
  handler = () => { throw new TypeError('network'); };
  check('ağ hatası -> bekleyen, istisna yok', (await processReceipts([{ id: 'a', token: tok(1) }])).pending.length, 1);

  requests.length = 0;
  handler = (body) => ({ body: { data: Object.fromEntries(body.ids.map((id) => [id, { status: 'ok' }])) } });
  const many = await processReceipts(Array.from({ length: 650 }, (_, i) => ({ id: `m${i}`, token: tok(i) })));
  check('650 makbuz 300\'lük gruplara bölünür, hepsi ok', [requests.map((b) => b.ids.length), many.ok], [[300, 300, 50], 650]);

  global.fetch = realFetch;
  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
