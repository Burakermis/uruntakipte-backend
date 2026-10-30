// Hata izleme (monitoring/sentry.js): DSN yokken tamamen kapalı; DSN varken olay GERÇEKTEN gider ama kişisel/gizli
// veri sızmaz. Sahte Sentry sunucusu yerel bir HTTP sunucusudur — dış ağa çıkılmaz. DB/Redis gerekmez.
process.env.NODE_ENV = 'test';
delete process.env.SENTRY_DSN;
const http = require('http');
const zlib = require('zlib');
const { initSentry, captureError, captureMessage, flush, scrubEvent } = require('./monitoring/sentry');

let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)} (beklenen: ${JSON.stringify(expected)})`);
}
const USER = 'f8447412-8155-46c1-b04f-2e0a77aa82ea';

(async () => {
  console.log('--- 1) DSN yokken tamamen kapalı');
  check('init false döner', initSentry('api'), false);
  check('captureError/captureMessage/flush hata fırlatmaz', (() => { try { captureError(new Error('x')); captureMessage('y'); return 'ok'; } catch { return 'hata'; } })(), 'ok');
  await flush(10);
  check('@sentry/node YÜKLENMEDİ (DSN yoksa maliyet yok)', Object.keys(require.cache).some((k) => k.includes(`${require('path').sep}@sentry${require('path').sep}node${require('path').sep}`)), false);

  console.log('\n--- 2) scrubEvent: kişisel/gizli veriyi atar');
  const event = {
    request: {
      url: `https://api.example.com/api/products?userId=${USER}&x=1`,
      query_string: `userId=${USER}&x=1`,
      data: { url: 'https://www.zara.com/x', sku: '1' },
      cookies: { s: 'GIZLI' },
      headers: { Authorization: 'Bearer SIR-DEGER', Cookie: 'a=b', 'User-Agent': 'node', 'X-Api-Key': 'k' },
    },
    user: { ip_address: '1.2.3.4', id: USER },
    breadcrumbs: [{ data: { url: `https://api.example.com/api/users/${USER}/limits` } }, { message: 'x' }],
    exception: { values: [{ type: 'Error', value: 'boom' }] },
  };
  const s = scrubEvent(JSON.parse(JSON.stringify(event)));
  check('istek gövdesi ve çerezler atıldı', [s.request.data, s.request.cookies], [undefined, undefined]);
  check('Authorization/Cookie/X-Api-Key başlıkları atıldı, User-Agent kaldı', Object.keys(s.request.headers), ['User-Agent']);
  check('URL ve sorgu dizgesindeki userId maskelendi', [s.request.url, s.request.query_string], ['https://api.example.com/api/products?userId=f84474***&x=1', 'userId=f84474***&x=1']);
  check('kullanıcı bilgisi (IP, id) atıldı', s.user, undefined);
  check('breadcrumb URL\'sindeki userId maskelendi', s.breadcrumbs[0].data.url, 'https://api.example.com/api/users/f84474***/limits');
  check('hata bilgisinin kendisi korundu', s.exception.values[0].value, 'boom');
  check('boş olay güvenli', [scrubEvent(null), scrubEvent({})], [null, {}]);

  console.log('\n--- 3) DSN varken olay yerel sahte sunucuya GİDER ve temizlenmiş olur');
  const received = [];
  const server = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);
        if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
        received.push({ url: req.url, text: body.toString('utf8') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${server.address().port}/1`;
  check('init true döner', initSentry('api'), true);
  check('ikinci init aynı örneği kullanır', initSentry('api'), true);
  captureError(new Error('deneme hatası'), { route: '/api/products' });
  captureMessage('[health] zara sağlıksız', 'error', { brand: 'zara' });
  await flush(3000);
  server.close();
  const all = received.map((r) => r.text).join('\n');
  check('sunucuya zarf (envelope) POST edildi', received.length > 0 && received.every((r) => r.url.startsWith('/api/1/envelope')), true);
  check('hata olayı ulaştı', all.includes('deneme hatası'), true);
  check('mesaj olayı ulaştı', all.includes('zara sağlıksız'), true);
  check('service etiketi eklendi', all.includes('"service":"api"'), true);
  check('ortam etiketi (test) eklendi', all.includes('"environment":"test"'), true);
  check('tracing/performans olayı YOK (yalnızca hata izleme)', all.includes('"type":"transaction"'), false);
  check('IP adresi gönderilmedi (sendDefaultPii kapalı)', /"ip_address":"(?!\{\{auto\}\})/.test(all) || all.includes('"user"'), false);

  console.log(`\n${ok ? '✔ Tüm testler geçti' : '✘ Bazı testler başarısız'}`);
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
