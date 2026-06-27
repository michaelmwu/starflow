#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

api_pid=""
web_pid=""

cleanup() {
  status="$?"
  trap - INT TERM HUP EXIT

  if [ -n "$web_pid" ] && kill -0 "$web_pid" 2>/dev/null; then
    kill "$web_pid" 2>/dev/null || true
    wait "$web_pid" 2>/dev/null || true
  fi

  if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi

  ./scripts/dev-db.sh stop postgres >/dev/null 2>&1 || true
  exit "$status"
}

trap cleanup INT TERM HUP EXIT

./scripts/db-migrate.sh
./scripts/local-env.sh exec -- bun run dev:api &
api_pid="$!"
./scripts/local-env.sh exec -- bun run dev &
web_pid="$!"

wait "$web_pid"
