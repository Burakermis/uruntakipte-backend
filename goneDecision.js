const { PRODUCT_GONE } = require('./constants');

// Bir hedefin sayfası "yok" (404/soft-404) döndüğünde abonelikleri kapatıp kapatmamaya karar verir. Tek bir 404
// geçici olabilir (mağaza dağıtımı, CDN hatası, bot korumasının 404'e düşmesi) ve kapatma kullanıcılar için geri
// alınamaz, bu yüzden üç şart aranır. Saf karar: I/O yok (marka istatistiği yalnızca gerektiğinde yüklenir).
//
//   'wait'   : kanıt henüz yetmiyor (az kontrol ya da seri çok yeni). Abonelikler korunur, tarama sürer.
//   'hold'   : kanıt yeterli ama markanın hedeflerinin büyük kısmı da şüpheli -> ürün değil site sorunu.
//              Abonelikler korunur. maxHoldMs dolunca bu da 'remove' olur (24 saat kesintisiz 404 gerçektir).
//   'remove' : aboneleri kapat.
//
// 410 Gone sunucunun "kalıcı olarak kalktı" demesidir: bekleme ve şalter uygulanmaz.
//
// input: { status, count, firstSeenAt (ms), now (ms) } — count bu kontrol DAHİL ardışık 404 sayısı.
// loadBrandStats: async () => ({ active, suspects }) — suspects bu hedef DAHİL 404 serisindeki aktif hedef sayısı.
async function decideGone({ status, count, firstSeenAt, now = Date.now() }, loadBrandStats, config = PRODUCT_GONE) {
  if (status === 410) return 'remove';

  const elapsedMs = now - firstSeenAt;
  if (count < config.minChecks || elapsedMs < config.minDurationMs) return 'wait';
  if (elapsedMs >= config.maxHoldMs) return 'remove';

  const { active, suspects } = await loadBrandStats();
  const siteWide = active >= config.brandMinTargets && suspects / active >= config.brandSuspectRatio;
  return siteWide ? 'hold' : 'remove';
}

module.exports = { decideGone };
