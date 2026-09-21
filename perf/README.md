# Performans testleri

Gerçek `store/`, `routes/`, `queue/` kodunu **sentetik veriyle, izole bir veritabanında** çalıştırır.
Marka sitelerine **hiç istek atmaz** (yük testi üçüncü tarafa yük bindirmemeli, bot engelini de tetiklememeli):
sayfa çekimi `perf/stub-fetch.js` ile ölçülmüş gecikmeler ve yerel fixture HTML'iyle taklit edilir.

## Hazırlık

Testler tabloları `TRUNCATE` eder. `DATABASE_URL`'in veritabanı adı `perf`/`e2e`/`test` içermiyorsa
`perf/lib.js` çalışmayı reddeder (geliştirme veritabanını silmemek için).

```bash
docker start backend-postgres-1   # ya da docker compose up -d
docker exec backend-postgres-1 psql -U trackprice -d postgres -c "CREATE DATABASE trackprice_perf OWNER trackprice;"
docker run -d --name perf-redis -p 6380:6379 redis:7-alpine
export DATABASE_URL=postgres://trackprice:trackprice@localhost:5433/trackprice_perf REDIS_PORT=6380 LOG_LEVEL=warn
```

## Testler

| Komut | Ne ölçer | Bütçe / beklenen |
|---|---|---|
| `npm run perf:tick [500,2000,8000]` | Tik döngüsü (`runCheckCycle`) hedef sayısıyla nasıl büyüyor; sorgu sayısı ve `users` yazmaları | tik < 60 sn; sorgu sayısı hedeften bağımsız |
| `npm run perf:api [hedef]` | `GET /products` (5/50/200 ürün), `limits`, `POST /products`; **tik çalışırken** kullanıcı gecikmesi | p95 makul; tikte API donmamalı |
| `npm run perf:history` | `price_history` büyüme modeli, `previousPrice` gecikmesi, gece temizliği süresi | |
| `npm run perf:worker [hedef]` | N hedef aynı anda "sırası gelmiş" iken tek worker kaç sn'de eritiyor (alan-adı aralığı dahil) | N hedef ≤ 60 sn ⇒ N premium hedef sürdürülebilir |

`CHECK_CONCURRENCY=10 npm run perf:worker` ile slot sayısı denenebilir (worker ve bench aynı değeri okur).
`STUB_LATENCY_SCALE=0.5` siteleri iki kat hızlı taklit eder.

## Doğruluk testleri (performans için yapılan değişikliklerin davranışı değiştirmediğini kanıtlar)

`npm run test:unit` — aynı `DATABASE_URL` gerekir. `test-check-schedule.js` (toplu karar == tekil karar),
`test-batching.js` (salt-okunur `isPremium`, toplu `previousPrices`, değişimde yazan geçmiş, `GET /products`),
`test-claim-attempt.js` (eşzamanlı işler aynı hedefi tekrar taramaz), `test-domain-limiter.js` (alan-adı aralığı).

## Bilinen sınır

Alan-adı aralığı (1,5 sn) tek çıkış IP'sinden marka başına en fazla **40 kontrol/dk** demek; bir marka 40'tan
fazla premium hedef taşırsa o markanın 1 dk'lık aralığı tutulamaz. Bu bir kod değil mimari sınır
(bkz. `queue/worker-process.js` yorumu).
