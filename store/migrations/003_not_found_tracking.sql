-- "Ürün sayfası yok" (404/soft-404) tespitinin tek denemeyle abonelikleri kapatmaması için (bkz. goneDecision.js):
--   not_found_since : kesintisiz 404 serisinin başladığı an (başarılı bir kontrol sıfırlar)
--   not_found_count : o seride kaç kontrol 404 gördü
ALTER TABLE tracked_targets ADD COLUMN IF NOT EXISTS not_found_since TIMESTAMPTZ;
ALTER TABLE tracked_targets ADD COLUMN IF NOT EXISTS not_found_count INT NOT NULL DEFAULT 0;
