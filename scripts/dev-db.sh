#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

worktree_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
real_worktree_root="$(cd "$worktree_root" && pwd -P)"
default_project_name="$(basename "$real_worktree_root")"
default_project_name="$(printf '%s' "$default_project_name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$default_project_name}"

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
  ENV_FILE=".env.example"
fi

PORT_ENV_FILE="$(mktemp)"
trap 'rm -f "$PORT_ENV_FILE"' EXIT HUP INT TERM
./scripts/local-env.sh env > "$PORT_ENV_FILE"

if [ "$ENV_FILE" = ".env" ]; then
  exec docker compose -f compose.yml --env-file .env.example --env-file "$PORT_ENV_FILE" --env-file .env "$@"
fi

exec docker compose -f compose.yml --env-file .env.example --env-file "$PORT_ENV_FILE" "$@"
