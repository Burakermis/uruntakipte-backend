-- Premium durumunun güvenilir senkronu (bkz. billing/plan.js, billing/reconcile.js):
--   premium_event_at   : durumu en son değiştiren RevenueCat olayının zamanı. Geç gelen eski olay (yeniden deneme,
--                        sıra karışması) daha yeni bir durumu ezmesin diye karşılaştırılır.
--   premium_checked_at : RevenueCat'ten en son ne zaman doğrulandığı. Kaçan bir EXPIRATION/iade olayı premium'u sonsuza
--                        kadar açık bırakmasın diye periyodik uzlaştırma bu alana göre eskileri yeniden sorgular.
ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_event_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_premium_checked ON users (premium_checked_at) WHERE is_premium;
