# Ürün Fiyat & Stok Takip Uygulaması — Roadmap

Alışveriş uygulamalarından "paylaş" ile ürün ekleyip, periyodik web scraping ile fiyat/stok takibi yapan ve değişiklikte push bildirimi gönderen React Native uygulaması için geliştirme yol haritası.

---

## Mimari Özeti

```
Alışveriş App → RN App (Share Extension) → Backend API → Veritabanı
                                                  ↓
                                            Zamanlayıcı (cron)
                                                  ↓
                                              Kuyruk (Redis/BullMQ)
                                                  ↓
                                        Worker (scraper: fetch + parse)
                                                  ↓
                                    Başarılı mı? → Evet → DB güncelle + Push bildirim
                                                → Hayır → Backoff, kuyruğa geri dön
```

---

## Faz 0 — Planlama & Teknoloji Seçimi (1 hafta)

- [ ] Hedef alışveriş sitelerini belirle (resmi API var mı, yoksa scraping gerekecek mi?)
- [ ] Backend yaklaşımına karar ver: Serverless (Cloud Functions + Cloud Scheduler) vs. Node.js sunucu (node-cron/BullMQ)
- [ ] Veritabanı seç: PostgreSQL (Supabase) veya Firestore
- [ ] Push bildirim servisi: Firebase Cloud Messaging
- [ ] Hedef sitelerin kullanım şartlarını (ToS) ve robots.txt'lerini incele

## Faz 1 — MVP: Paylaşım ve Manuel Takip (2-3 hafta)

- [ ] RN projesini bare workflow'a geçir (Share Extension için gerekli)
- [ ] Android: `intent-filter` ile `ACTION_SEND` yakalama
- [ ] iOS: Share Extension target ekleme
- [ ] Paylaşılan URL'yi backend'e `POST /products` ile gönderme
- [ ] `products` tablosunu oluşturma (url, name, last_price, last_stock, user_id)
- [ ] Basit bir scraper fonksiyonu (Cheerio ile HTML parse) — tek seferlik, manuel tetiklenen
- [ ] RN tarafında ürün listesi ekranı (mevcut fiyat/stok gösterimi)

## Faz 2 — Otomatik Periyodik Kontrol (2-3 hafta)

- [ ] Zamanlayıcı kurulumu (Cloud Scheduler veya node-cron)
- [ ] Kuyruk sistemi kurulumu (Redis + BullMQ)
- [ ] Worker: kuyruktaki job'ları alıp sayfayı çekme + parse etme
- [ ] Değişiklik tespit mantığı (yeni değer vs. `last_price`/`last_stock`)
- [ ] Her ürün için ayarlanabilir `check_interval` alanı
- [ ] Domain bazlı rate limiting (aynı siteye çok sık istek atmama)

## Faz 3 — Bildirimler (1-2 hafta)

- [ ] Firebase projesini RN uygulamasına bağlama
- [ ] Bildirim izni isteme + FCM token alma
- [ ] Token'ı kullanıcı ile ilişkilendirip backend'e kaydetme
- [ ] Sunucu tarafında `firebase-admin` ile push gönderme
- [ ] Bildirime tıklayınca ürün detay sayfasına deep link
- [ ] Arka plan / kapalı uygulama bildirim davranışını yönetme (notification channel, background handler)
- [ ] Anlamlı bildirim eşiği belirleme (örn. sadece %5+ fiyat değişiminde bildir)

## Faz 4 — Dayanıklılık & Ölçeklendirme (2-3 hafta)

- [ ] Hata sınıflandırma: parser hatası / engellenme (403-429) / timeout
- [ ] Retry + exponential backoff mekanizması
- [ ] User-agent rotasyonu, gerekirse proxy havuzu
- [ ] Ardışık başarısız denemelerde ürünü "pasif" işaretleme ve kullanıcıya bildirme
- [ ] Dinamik (JS ile render edilen) sayfalar için Playwright/Puppeteer entegrasyonu
- [ ] Selector kırılmalarını izleyen alert sistemi (site yapısı değiştiğinde geliştiriciye haber)

## Faz 5 — Kullanıcı Deneyimi İyileştirmeleri (2 hafta)

- [ ] `price_history` tablosu ile fiyat geçmişi grafiği
- [ ] Kullanıcı bazlı hedef fiyat belirleme ("bu fiyata düşünce haber ver")
- [ ] Çoklu cihaz desteği (kullanıcı başına birden fazla FCM token)
- [ ] Ürün kategorileme / favoriler
- [ ] Manuel "şimdi kontrol et" butonu

## Faz 6 — İzleme & Bakım (sürekli)

- [ ] Loglama ve hata izleme (Sentry vb.)
- [ ] Scraping başarı oranı dashboard'u
- [ ] Maliyet takibi (serverless kullanım, worker saatleri)
- [ ] Periyodik olarak hedef sitelerin ToS/robots.txt değişikliklerini kontrol etme

---

## Teknoloji Yığını

| Katman | Öneri |
|---|---|
| Mobil | React Native (bare workflow) |
| Share Extension | react-native-receive-sharing-intent |
| Backend | Node.js/Express veya Cloud Functions |
| Kuyruk | Redis + BullMQ |
| Scraping | Cheerio (statik) / Playwright (dinamik) |
| Veritabanı | PostgreSQL (Supabase) veya Firestore |
| Bildirim | Firebase Cloud Messaging |
| Zamanlayıcı | node-cron veya Cloud Scheduler |
| İzleme | Sentry / basit log servisi |

## Veri Modeli (özet)

**products**
`id, url, name, last_price, last_stock, user_id, check_interval, consecutive_failures, created_at`

**price_history**
`id, product_id, price, stock, checked_at`

**device_tokens**
`id, user_id, fcm_token, platform, created_at`

---

## Riskler & Notlar

- Bazı e-ticaret siteleri scraping'i kullanım şartlarında yasaklıyor — mümkün olan yerlerde resmi/affiliate API tercih edilmeli.
- Agresif tarama IP engellenmesine yol açabilir; rate limiting ve nazik tarama davranışı şart.
- Site HTML yapısı değiştiğinde parser'lar sessizce bozulabilir — mutlaka izleme/alert sistemi kurulmalı.
- iOS'ta arka plan bildirim davranışı Android'e göre daha kısıtlı; data-only payload tercih edilmeli.
