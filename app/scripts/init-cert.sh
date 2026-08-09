#!/usr/bin/env bash
# Получение первого сертификата. Запускать один раз, до docker compose up.
# Nginx ещё не поднят, поэтому certbot слушает 80-й порт сам (standalone).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Нет .env — скопируйте .env.example и заполните"; exit 1; }
set -a; . ./.env; set +a

: "${DOMAIN:?В .env не задан DOMAIN}"
: "${LETSENCRYPT_EMAIL:?В .env не задан LETSENCRYPT_EMAIL}"

if [ -d "certbot/conf/live/$DOMAIN" ]; then
  echo "Сертификат для $DOMAIN уже есть — пропускаю."
  exit 0
fi

echo "Проверяю, что 80-й порт свободен..."
if ss -ltn 2>/dev/null | grep -q ':80 '; then
  echo "Порт 80 занят. Остановите nginx/apache: docker compose down"
  exit 1
fi

mkdir -p certbot/conf certbot/www
docker run --rm -p 80:80 \
  -v "$PWD/certbot/conf:/etc/letsencrypt" \
  -v "$PWD/certbot/www:/var/www/certbot" \
  certbot/certbot certonly --standalone \
  -d "$DOMAIN" --email "$LETSENCRYPT_EMAIL" \
  --agree-tos --no-eff-email --non-interactive

echo "Готово: certbot/conf/live/$DOMAIN/"
