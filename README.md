# Urun Takipte - Backend

Backend API for Urun Takipte product tracking system.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

## Docker ile dağıtım

API ve worker **aynı imajı** kullanır (`Dockerfile`), yalnızca komut değişir. İmaj Playwright'ın resmi imajı üzerine kurulur (Chromium hazır) ve H&M gibi görünür pencere isteyen markalar için sanal ekran (Xvfb) başlatır.

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
