// `node -r ./perf/stub-fetch.js queue/worker-process.js` ile worker'a ÖNCEDEN
// yüklenir: sayfa çekimini (fetchHtml) markanın ÖLÇÜLMÜŞ gecikmesiyle bekleyip
// yerel fixture HTML'ini döner. Böylece gerçek parser, checker, veritabanı ve
// kuyruk kodu çalışır ama hiçbir marka sitesine istek gitmez (yük testi 3.
// tarafa yük bindirmemeli, bot engelini de tetiklememeli).
//
// Gecikmeler 2026-09-21'de canlı ölçülen kontrol sürelerinden (bkz.
// worker-process 'kontrol tamamlandı' logları). STUB_LATENCY_SCALE ile
// ölçeklenebilir (ör. 0.5 = siteler iki kat hızlı).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const fetchMod = require(path.join(root, 'scraper/fetchHtml'));
const browserMod = require(path.join(root, 'scraper/browserFetch'));

const FIXTURE_FILE = {
  zara: 'zara-aaron-levine-tshirt.html',
  hm: 'hm-product-snippet.html',
  pullandbear: 'pullandbear-cift-kollu-tisort.html',
  bershka: 'bershka-baskili-tshirt.html',
  mango: 'mango-denim-ceket.html',
  massimodutti: 'massimodutti-tshirt.html',
  stradivarius: 'stradivarius-pantolon.html',
  oysho: 'oysho-ceket.html',
};
// ms — sayfa çekimi (parse ve DB hariç)
const LATENCY_MS = {
  mango: 600,
  zara: 850,
  massimodutti: 1500,
  bershka: 1500,
  oysho: 1700,
  hm: 3200,
  pullandbear: 3400,
  stradivarius: 4500,
};
const scale = Number(process.env.STUB_LATENCY_SCALE || 1);
const html = {};
for (const [brand, file] of Object.entries(FIXTURE_FILE)) {
  html[brand] = fs.readFileSync(path.join(root, 'fixtures', file), 'utf8');
}

fetchMod.fetchHtml = async (url, { brandId } = {}) => {
  const base = (LATENCY_MS[brandId] ?? 1500) * scale;
  await new Promise((resolve) => setTimeout(resolve, base * (0.8 + Math.random() * 0.4)));
  return { html: html[brandId], source: 'perf-stub' };
};
browserMod.prewarmBrowser = () => Promise.resolve();
