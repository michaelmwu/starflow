#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

api_pid=""
web_pid=""
exit_file=""

worktree_root() {
  if root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    cd "$root"
    pwd -P
  else
    pwd -P
  fi
}

process_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

stop_same_worktree_port() {
  port="$1"
  root="$2"

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    if [ "$(process_cwd "$pid")" = "$root" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

reclaim_same_worktree_port() {
  port="$1"
  root="$2"

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    if [ "$(process_cwd "$pid")" = "$root" ]; then
      echo "Stopping previous local dev process $pid on port $port."
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}

run_and_report() {
  name="$1"
  shift

  (
    child_pid=""
    trap 'if [ -n "$child_pid" ]; then kill "$child_pid" 2>/dev/null || true; wait "$child_pid" 2>/dev/null || true; fi; exit 143' INT TERM HUP

    set +e
    "$@" &
    child_pid="$!"
    wait "$child_pid"
    code="$?"
    set -e

    printf '%s %s\n' "$name" "$code" >"$exit_file"
    exit "$code"
  )
}

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
  if [ -n "${root:-}" ]; then
    stop_same_worktree_port "${VITE_PORT:-}" "$root"
    stop_same_worktree_port "${PORT:-}" "$root"
  fi
  if [ -n "$exit_file" ]; then
    rm -f "$exit_file"
  fi
  exit "$status"
}

trap cleanup INT TERM HUP EXIT

root="$(worktree_root)"
eval "$(./scripts/local-env.sh env)"
reclaim_same_worktree_port "$VITE_PORT" "$root"
reclaim_same_worktree_port "$PORT" "$root"

./scripts/db-migrate.sh
exit_file="$(mktemp "${TMPDIR:-/tmp}/starflow-dev-local.XXXXXX")"
rm -f "$exit_file"

run_and_report api ./scripts/local-env.sh exec -- bun run dev:api &
api_pid="$!"
run_and_report web ./scripts/local-env.sh exec -- bun run dev &
web_pid="$!"

while [ ! -f "$exit_file" ]; do
  sleep 1
done

set -- $(cat "$exit_file")
echo "$1 process exited with code $2."
exit "$2"
