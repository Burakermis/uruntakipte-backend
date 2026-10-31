// CANLI duman testi: her markanın gerçek bir ürün sayfasını sunucunun kendi yoluyla (fetchHtml) indirip
// parser'dan geçirir. Birim testleri kayıtlı (eski) HTML ile çalıştığı için site yapısı değişince
// yeşil kalıp canlıda her ürünü PARSE_FAILED yapabilir (Mango, 2026-10); bunu yalnızca bu test yakalar.
//
// Üç sonuç ayrılır:
//   OK       sayfa indi, ad + fiyat + en az bir beden okundu
//   ENGELLİ  sayfa indirilemedi (bot koruması / ağ) -> parser hakkında bilgi vermez, UYARI (çıkış kodu 0)
//   KIRIK    sayfa indi ama parser veri okuyamadı -> HATA (çıkış kodu 1): yapı değişmiş ya da URL ölmüş
//
// Çalıştırma: npm run test:live            (hepsi)
//             npm run test:live -- mango   (belirli markalar)
// CI'da KOŞMAZ (GitHub IP'leri engellenir); canlıya almadan önce ve haftalık, SUNUCUNUN kendi IP'sinden çalıştır.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
const urls = require('./fixtures/live-urls.json');
const { fetchHtml } = require('./scraper/fetchHtml');
const { resolveProductFromHtml, detectBrand } = require('./scraper/registry');
const { closeBrowser } = require('./scraper/browserFetch');

const only = process.argv.slice(2);
const brandIds = Object.keys(urls).filter((k) => !k.startsWith('_') && (only.length === 0 || only.includes(k)));

async function checkBrand(id) {
  const url = urls[id];
  const brand = detectBrand(url);
  if (!brand || brand.id !== id) return { id, status: 'KIRIK', detail: `URL ${id} markasına eşlenmiyor` };

  const started = Date.now();
  const fetched = await fetchHtml(url, { brandId: id });
  if (fetched?.notFound) {
    return { id, status: 'KIRIK', detail: `ürün URL'i ölü (HTTP ${fetched.status ?? 'soft-404'}) — fixtures/live-urls.json'u güncelle` };
  }
  if (!fetched) return { id, status: 'ENGELLİ', detail: 'sayfa indirilemedi' };

  const result = resolveProductFromHtml({ url, html: fetched.html });
  const ms = Date.now() - started;
  if (result.error) {
    const title = (fetched.html.match(/<title>([^<]*)/i) || [])[1] || '';
    if (/bulunamad|not found|404/i.test(title)) {
      return { id, status: 'KIRIK', detail: `ürün URL'i ölü ("${title.trim()}") — fixtures/live-urls.json'u güncelle` };
    }
    return { id, status: 'KIRIK', detail: `${result.error} (sayfa ${Math.round(fetched.html.length / 1024)} KB indi)` };
  }
  const problems = [];
  if (!result.name) problems.push('ad yok');
  if (!Array.isArray(result.variants) || result.variants.length === 0) problems.push('beden yok');
  else if (!result.variants.some((v) => typeof v.price === 'number' && v.price > 0)) problems.push('fiyat yok');
  if (problems.length) return { id, status: 'KIRIK', detail: problems.join(', ') };

  const first = result.variants[0];
  return { id, status: 'OK', detail: `${result.name} · ${result.variants.length} varyant · ${first.price} ${first.currency} · ${ms} ms` };
}

(async () => {
  const results = [];
  for (const id of brandIds) {
    // Sırayla: aynı IP'den markalara aynı anda yüklenmeyelim.
    const r = await checkBrand(id).catch((err) => ({ id, status: 'KIRIK', detail: `istisna: ${err.message}` }));
    results.push(r);
    console.log(`${r.status.padEnd(8)} ${r.id.padEnd(13)} ${r.detail}`);
  }
  await closeBrowser();

  const broken = results.filter((r) => r.status === 'KIRIK');
  const blocked = results.filter((r) => r.status === 'ENGELLİ');
  console.log(`\n${results.length - broken.length - blocked.length} OK, ${blocked.length} engelli, ${broken.length} kırık`);
  if (blocked.length) console.log('Engelli markalar bu IP\'den doğrulanamadı: ' + blocked.map((r) => r.id).join(', '));
  if (broken.length) console.log('KIRIK: ' + broken.map((r) => r.id).join(', '));
  process.exit(broken.length ? 1 : 0);
})();
