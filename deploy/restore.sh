#!/usr/bin/env sh
set -eu

: "${POSTGRES_USER:?set POSTGRES_USER}"
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"
: "${POSTGRES_DB:=deep_research}"
: "${BACKUP_FILE:?set BACKUP_FILE to a pg_dump -Fc file}"
: "${COMPOSE_ENV_FILE:=deploy/.env.production}"

test -f "$BACKUP_FILE"
printf 'Restoring %s into %s; existing data will be replaced.\n' "$BACKUP_FILE" "$POSTGRES_DB"
printf 'Type RESTORE to continue: '
read answer
test "$answer" = RESTORE

docker compose --env-file "$COMPOSE_ENV_FILE" -f deploy/compose.production.yaml exec -T postgres \
  pg_restore --clean --if-exists --no-owner --exit-on-error \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$BACKUP_FILE"
