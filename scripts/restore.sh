#!/usr/bin/env bash
# Yedeği veritabanına geri yükler (scripts/backup.sh çıktısı). MEVCUT VERİLERİN ÜZERİNE YAZAR — bu yüzden
# açık onay ister:
#   ./scripts/restore.sh backups/trackprice-20261030-030000.sql.gz --yes
# Ortam değişkenleri: PG_CONTAINER (uruntakipte-postgres-1) · PG_DB (trackprice) · PG_USER (trackprice)
# Geri yüklemeden önce API ve worker'ı durdurun (docker compose --profile app stop api worker).
set -euo pipefail

file="${1:-}"
confirm="${2:-}"
CONTAINER="${PG_CONTAINER:-uruntakipte-postgres-1}"
DB="${PG_DB:-trackprice}"
DB_USER="${PG_USER:-trackprice}"

if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "Kullanım: $0 <yedek.sql.gz> --yes" >&2
  exit 2
fi
if [ "$confirm" != "--yes" ]; then
  echo "Bu işlem '$DB' veritabanının ÜZERİNE YAZAR. Onaylamak için sonuna --yes ekleyin." >&2
  exit 2
fi
gzip -t "$file"

gunzip -c "$file" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB" -v ON_ERROR_STOP=1 -q > /dev/null
echo "Geri yüklendi: $file -> $DB"
