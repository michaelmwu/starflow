#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

./scripts/dev-db.sh up -d postgres

ready=0
for _ in $(seq 1 40); do
  if ./scripts/dev-db.sh exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "Postgres did not become ready before migration timeout." >&2
  exit 1
fi

./scripts/dev-db.sh exec -T postgres sh -c '
  set -eu
  for migration in /migrations/*.sql; do
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$migration"
  done
'
