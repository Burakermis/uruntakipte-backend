-- Aynı kullanıcı + hedef + beden için TEK abonelik satırı. Eşzamanlı istekler (çift dokunma, yeniden deneme) bu kısıt
-- olmadan mükerrer satır yaratıyordu: bir fiyat düşüşü için aynı kullanıcıya birden çok push gidiyordu.
--
-- Önce mevcut mükerrerleri temizler: grupta AKTİF olan satır, aktif yoksa en yenisi korunur.
DELETE FROM subscriptions s
USING (
  SELECT id,
         row_number() OVER (PARTITION BY user_id, target_id, sku ORDER BY active DESC, id DESC) AS rn
  FROM subscriptions
) d
WHERE s.id = d.id AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_target_sku ON subscriptions (user_id, target_id, sku);
