-- H&M desteği kaldırıldı (bot koruması bu ağlardan geçilemiyor; bkz. git geçmişi scraper/brands/hm.js).
-- Kalan H&M kayıtlarını bağımlılık sırasıyla temizler: önce fiyat geçmişi ve abonelikler, sonra hedefler.
-- Yeni veritabanlarında hiçbir şey silmez (idempotent). Bildirim geçmişinde kalan H&M bağlantıları
-- zaten NOTIFICATION_RETENTION_DAYS sonunda silinir, ama bağlantısı artık açılamayacağı için burada da temizlenir.
DELETE FROM price_history WHERE target_id IN (SELECT id FROM tracked_targets WHERE brand = 'hm');
DELETE FROM subscriptions WHERE target_id IN (SELECT id FROM tracked_targets WHERE brand = 'hm');
DELETE FROM tracked_targets WHERE brand = 'hm';
DELETE FROM notifications WHERE product_url LIKE '%hm.com/%';
