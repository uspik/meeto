#!/usr/bin/env bash
# Дамп базы в backups/. Держите копию вне сервера.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
mkdir -p backups
FILE="backups/meeto-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T db pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" | gzip > "$FILE"
echo "Сохранено: $FILE"
# оставляем 14 последних
ls -1t backups/*.sql.gz | tail -n +15 | xargs -r rm --
