#!/usr/bin/env bash
# Postgres yedeği (gzip) + eski yedeklerin temizliği. Cron/systemd zamanlayıcısıyla günlük çalıştırın, ör.:
#   0 3 * * *  cd /opt/uruntakipte/backend && ./scripts/backup.sh >> backups/backup.log 2>&1
# Yedekler SUNUCUDA durur: sunucu diskine bağımlı olmamak için backups/ klasörünü ayrıca başka bir yere
# (nesne depolama, başka makine) kopyalayın. Geri yükleme: scripts/restore.sh
#
# Ortam değişkenleri (hepsi isteğe bağlı):
#   BACKUP_DIR (varsayılan ./backups) · KEEP_DAYS (14) · PG_CONTAINER (uruntakipte-postgres-1)
#   PG_DB (trackprice) · PG_USER (trackprice)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
CONTAINER="${PG_CONTAINER:-uruntakipte-postgres-1}"
DB="${PG_DB:-trackprice}"
DB_USER="${PG_USER:-trackprice}"

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/${DB}-$(date +%Y%m%d-%H%M%S).sql.gz"

# --clean --if-exists: geri yüklemede mevcut nesneler önce düşürülür (boş ya da dolu veritabanına yüklenebilir).
docker exec "$CONTAINER" pg_dump -U "$DB_USER" --no-owner --clean --if-exists "$DB" | gzip > "$file.tmp"

# Boş/bozuk yedeği saklama: sıkıştırma bütünlüğü ve en az bir tablo tanımı.
if ! gzip -t "$file.tmp" || ! gunzip -c "$file.tmp" | grep -q 'CREATE TABLE'; then
  rm -f "$file.tmp"
  echo "HATA: yedek doğrulanamadı (boş ya da bozuk): $DB" >&2
  exit 1
fi
mv "$file.tmp" "$file"

find "$BACKUP_DIR" -name "${DB}-*.sql.gz" -mtime +"$KEEP_DAYS" -delete
echo "$file ($(du -h "$file" | cut -f1))"
