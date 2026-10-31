# Urun Takipte - Backend

Backend API for Urun Takipte product tracking system.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

## Docker ile dağıtım

API ve worker **aynı imajı** kullanır (`Dockerfile`), yalnızca komut değişir. İmaj Playwright'ın resmi imajı üzerine kurulur (Chromium hazır).

```bash
docker build -t uruntakipte-backend .
docker run -d --init -p 4000:4000 --env-file .env.production uruntakipte-backend                              # API
docker run -d --init --env-file .env.production uruntakipte-backend node queue/worker-process.js            # worker
```

Tek makinede (VPS) Postgres + Redis + API + worker birlikte:

```bash
# .env.production: AUTH_SECRET, POSTGRES_PASSWORD, REVENUECAT_* (bkz. .env.example)
docker compose --env-file .env.production --profile app up -d --build
```

Dikkat:
- `NODE_ENV=production`, `AUTH_SECRET` (≥32 karakter) ve varsayılan olmayan bir veritabanı parolası **zorunlu**; yoksa süreç 1 koduyla kapanır.
- API 4000'i yalnızca `127.0.0.1`'e bağlar; internete bir ters vekil (TLS) üzerinden aç. Vekil arkasında `TRUST_PROXY=<vekil sayısı>` ver (compose'ta varsayılan 1); yoksa hız sınırı herkesi tek IP sayar. Vekilsiz doğrudan açıyorsan `0` bırak.
- Sağlık kontrolü (`/api/health`) loglanmaz; 4xx `warn`, 5xx `error` seviyesinde yazılır.
- `PLAYWRIGHT` sürümü imaj etiketiyle (`Dockerfile`) aynı olmalı; `playwright` paketini yükseltirsen etiketi de güncelle.
- Yönetilen Redis için `REDIS_PASSWORD` ve `REDIS_TLS=1`; yönetilen Postgres için `DATABASE_URL` sonuna `?sslmode=require`.

## Yedekleme ve geri yükleme

```bash
./scripts/backup.sh                                  # backups/trackprice-<tarih>.sql.gz üretir, 14 günden eskileri siler
./scripts/restore.sh backups/<dosya>.sql.gz --yes    # MEVCUT verinin üzerine yazar; önce API ve worker'ı durdurun
```

- Günlük otomatik yedek için cron/systemd zamanlayıcısı ekleyin (betiğin başındaki yoruma bakın).
- Yedekler sunucu diskinde durur: `backups/` klasörünü ayrıca başka bir yere (nesne depolama, başka makine) kopyalayın.
- Betik boş/bozuk yedeği saklamaz (sıkıştırma bütünlüğü + tablo tanımı kontrolü). Geri yüklemeyi **düzenli olarak bir deneme veritabanında** deneyin.

## İzleme

- `node scripts/brand-health.js`: marka bazlı tarama sağlığı (aktif / ardışık hata veren hedef sayısı, en sık hata). Worker bunu 30 dakikada bir loglar; bir markanın aktif hedeflerinin ≥%50'si (en az 3 hedef) ardışık hata veriyorsa `error` seviyesinde `[health] ... sağlıksız` yazar.
- Push teslimat makbukları ~15 dk sonra kontrol edilir; FCM/APNs kimlik bilgisi hatası `error` seviyesinde `TESLİMAT HATASI` olarak loglanır.
- Bir ürün 10 ardışık taramada okunamazsa (yaklaşık bir gün) takipçilerine bir kez "takip edilemiyor" bildirimi gider.

## Veritabanı şeması (migration'lar)

Şema `store/migrations/NNN_ad.sql` dosyalarıyla yönetilir; API açılışta (`db.migrate()`) sırayla ve her biri tek işlemde uygular, `schema_migrations` tablosuna yazar. Aynı anda birden çok süreç açılırsa Postgres kilidi sayesinde tek biri uygular.

- Şema değişikliği = **yeni dosya** (`002_...sql`, `003_...sql`). Uygulanmış bir dosyayı **düzenleme**: içeriği değişirse sağlama toplamı uyuşmaz ve sunucu açılmaz.
- Başarısız migration geri alınır, kaydedilmez ve sonrakiler çalışmaz; hata dosya adını söyler.
- `001_baseline.sql` eski `schema.sql`'in birebir halidir (idempotent): mevcut veritabanlarına zarar vermeden uygulanır.
- Geri alma (down) migration'ı yoktur: riskli değişikliklerden önce `scripts/backup.sh` çalıştırın.

## Premium ve abonelik güvenliği

- **Premium durumunun kaynağı RevenueCat'tir.** Webhook hızlı yoldur; `EXPIRATION`, `CANCELLATION` ve `TRANSFER` olayları tek başına yeterli sayılmaz, RevenueCat'e sorulur. Olaylar zaman damgasıyla sıralanır (geç gelen eski olay yeni durumu ezmez) ve webhook kaçsa bile saatlik `premium-reconcile` işi premium görünen kullanıcıları günde bir kez RevenueCat'e göre doğrular (bkz. `billing/`).
- **Premium bitince ücretsiz sınır uygulanır:** en eski 3 ürün takipte kalır, fazlası pasifleşir ve kullanıcıya bildirim gider. Bu kapatma "çıkardıktan sonra 48 saat bekle" kuralını tetiklemez.
- **Ürün ekleme/çıkarma kullanıcı başına kilitlidir** (`subscriptionStore.withUserLock`): eşzamanlı istekler limiti ve bekleme süresini aşamaz, `(kullanıcı, ürün, beden)` tekildir. Limiti dolu kullanıcının görülmemiş bir URL'si sayfa taramasını tetiklemez; tarama uçlarında ve `sync-premium`'da kullanıcı başına hız sınırı vardır.
- **Canlıda** `REVENUECAT_WEBHOOK_SECRET` ve `REVENUECAT_SECRET_KEY` zorunludur; yoksa API açılmaz. Henüz ücretli plan olmadan yayına çıkılıyorsa `ALLOW_MISSING_BILLING=1` verin.
- **Bilinen sınır:** kimlik cihazda üretilir; yeniden kurulum ya da hesap silme yeni bir kimlik (ve yeni ücretsiz limit) demektir. Bunu yalnızca cihaz doğrulaması (App Attest / Play Integrity) ya da gerçek hesap sistemi kapatır; kayıt IP başına saatte 20 ile yavaşlatılır.

## Hız sınırı

Sayaçlar canlıda (`NODE_ENV=production`) Redis'te tutulur, böylece birden çok API örneği aynı sınırı paylaşır ve yeniden başlatma sayacı sıfırlamaz. Redis erişilemezse istekler engellenmez (sınırlayıcı tek başına kesinti nedeni olmasın). `RATE_LIMIT_STORE=memory|redis` ile zorlanabilir.
