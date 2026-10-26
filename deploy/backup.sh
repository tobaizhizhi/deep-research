#!/usr/bin/env sh
set -eu

: "${POSTGRES_USER:?set POSTGRES_USER}"
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"
: "${POSTGRES_DB:=deep_research}"
: "${BACKUP_DIR:=./backups}"
: "${COMPOSE_ENV_FILE:=deploy/.env.production}"

mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$BACKUP_DIR/${POSTGRES_DB}_${stamp}.dump"

docker compose --env-file "$COMPOSE_ENV_FILE" -f deploy/compose.production.yaml exec -T postgres \
  pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB" > "$file"
chmod 600 "$file"
printf 'backup=%s\n' "$file"
