-- Şema idempotent: server.js her açılışta çalıştırır (migration aracı yok,
-- bu ölçekte gereksiz karmaşıklık olurdu — IF NOT EXISTS yeterli).

CREATE TABLE IF NOT EXISTS tracked_targets (
  id SERIAL PRIMARY KEY,
  url_keys TEXT[] NOT NULL DEFAULT '{}',
  brand TEXT,
  url TEXT,
  product_id TEXT,
  name TEXT,
  image_url TEXT,
  canonical_url TEXT,
  variants JSONB NOT NULL DEFAULT '[]',
  consecutive_failures INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  last_check_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- last_checked_at = son BAŞARILI kontrol (kullanıcıya "en son ne zaman
-- baktık" olarak gösterilen değer), last_attempt_at = son DENEME (başarısız
-- olsa da). İkisi ayrı olmak zorunda: geri çekilme (backoff) hesabı denemeye
-- bakmalı, yoksa hiç başarılı olmayan bir hedef "üzerinden çok zaman geçti"
-- diye her tik'te yeniden denenir (bkz. checkSchedule.js). Tablo zaten
-- varsa bu ALTER ile eklenir — CREATE TABLE IF NOT EXISTS mevcut tabloya
-- kolon EKLEMEZ.
ALTER TABLE tracked_targets ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tracked_targets_url_keys ON tracked_targets USING GIN (url_keys);
CREATE INDEX IF NOT EXISTS idx_tracked_targets_active ON tracked_targets (active);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_id INT NOT NULL REFERENCES tracked_targets(id),
  sku TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  notify_on_price_drop BOOLEAN NOT NULL DEFAULT true,
  notify_on_back_in_stock BOOLEAN NOT NULL DEFAULT false,
  last_notified_price NUMERIC,
  last_notified_availability TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_target_id ON subscriptions (target_id);

CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  target_id INT NOT NULL REFERENCES tracked_targets(id),
  sku TEXT NOT NULL,
  price NUMERIC,
  availability TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- previousPrice/previousPrices bir (hedef, sku) çiftinin EN SON kayıtlarını
-- ister (ORDER BY checked_at DESC LIMIT 50). Toplu sürüm (Ürünlerim listesi)
-- korelasyonlu alt sorgu kullandığı için planlayıcı checked_at indeksini
-- geriye tarayıp süzüyordu: 50 ürünlü listede ~400 ms (perf/bench-api.js).
-- Bu bileşik indeks o taramayı doğrudan (hedef, sku, zaman) sırasında yapar.
-- Eski (target_id, sku) indeksi bunun öneki olduğundan gereksiz — kaldırılıyor.
-- NOT: büyük bir tabloda CREATE INDEX yazmaları kısa süre bloklar (şema tek
-- transaction'da çalıştığı için CONCURRENTLY kullanılamıyor).
CREATE INDEX IF NOT EXISTS idx_price_history_target_sku_checked ON price_history (target_id, sku, checked_at DESC);
DROP INDEX IF EXISTS idx_price_history_target_sku;
CREATE INDEX IF NOT EXISTS idx_price_history_checked_at ON price_history (checked_at);

CREATE TABLE IF NOT EXISTS device_tokens (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  expo_push_token TEXT NOT NULL,
  platform TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);
-- Eskiden expo_push_token TEK BAŞINA UNIQUE idi ve çakışmada user_id
-- üzerine yazılıyordu: bir token'ı bilen herkes onu kendi kimliğine
-- "taşıyıp" gerçek sahibinin bildirimlerini kesebiliyordu. Artık tekillik
-- (kullanıcı, token) çiftinde: bir kullanıcının kaydı başkasınınkini
-- değiştiremez (bkz. store/deviceTokenStore.js). Eski tabloda bu kısıt
-- otomatik adıyla bulunur; CREATE TABLE IF NOT EXISTS onu düşürmez.
ALTER TABLE device_tokens DROP CONSTRAINT IF EXISTS device_tokens_expo_push_token_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_user_token ON device_tokens (user_id, expo_push_token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id ON device_tokens (user_id);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  is_premium BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
