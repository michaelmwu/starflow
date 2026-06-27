#!/usr/bin/env sh
set -eu

BASE_PORT=15400
SPAN=1000
RESERVED_BLOCK_SIZE=10
WEB_RESTRICTED_PORTS=" 1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 101 102 103 104 109 110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465 512 513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 989 990 993 995 1719 1720 1723 2049 3659 4045 5060 5061 6000 6566 6665 6666 6667 6668 6669 6697 10080 "

worktree_root() {
  if root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    cd "$root"
    pwd -P
  else
    pwd -P
  fi
}

hash_decimal() {
  root="$1"
  if command -v shasum >/dev/null 2>&1; then
    prefix="$(printf '%s' "$root" | shasum -a 256 | awk '{print substr($1, 1, 8)}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    prefix="$(printf '%s' "$root" | sha256sum | awk '{print substr($1, 1, 8)}')"
  else
    prefix="$(printf '%s' "$root" | openssl dgst -sha256 | awk '{print substr($NF, 1, 8)}')"
  fi

  awk -v hex="$prefix" '
    BEGIN {
      decimal = 0
      digits = "0123456789abcdef"
      hex = tolower(hex)
      for (pos = 1; pos <= length(hex); pos++) {
        value = index(digits, substr(hex, pos, 1)) - 1
        decimal = (decimal * 16) + value
      }
      print decimal
    }
  '
}

default_postgres_port() {
  if is_positive_integer "${CONDUCTOR_PORT:-}"; then
    block_end=$((CONDUCTOR_PORT + RESERVED_BLOCK_SIZE - 1))
    used=" ${VITE_PORT:-} ${PORT:-} "
    unused_port_in_block "$((CONDUCTOR_PORT + 1))" "$block_end" "$used"
    return 0
  fi

  value="$(hash_decimal "$(worktree_root)")"
  echo "$((BASE_PORT + (value % SPAN)))"
}

is_positive_integer() {
  case "${1:-}" in
    '' | *[!0-9]*) return 1 ;;
    *) [ "$1" -gt 0 ] ;;
  esac
}

is_web_restricted_port() {
  case "$WEB_RESTRICTED_PORTS" in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

is_used_port() {
  case "$2" in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

browser_safe_unused_port_in_block() {
  port="$1"
  end="$2"
  used="$3"

  while [ "$port" -le "$end" ]; do
    if ! is_web_restricted_port "$port" && ! is_used_port "$port" "$used"; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done

  echo "reserved Conductor port block does not have a browser-safe free port" >&2
  return 1
}

unused_port_in_block() {
  port="$1"
  end="$2"
  used="$3"

  while [ "$port" -le "$end" ]; do
    if ! is_used_port "$port" "$used"; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done

  echo "reserved Conductor port block does not have a free Postgres port" >&2
  return 1
}

default_app_port() {
  if is_positive_integer "${CONDUCTOR_PORT:-}"; then
    browser_safe_unused_port_in_block "$CONDUCTOR_PORT" "$((CONDUCTOR_PORT + RESERVED_BLOCK_SIZE - 1))" " "
    return 0
  fi

  echo 5173
}

load_dotenv() {
  if [ -f ".env" ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
  fi
}

load_env() {
  load_dotenv
  VITE_PORT="${VITE_PORT:-$(default_app_port)}"
  if is_positive_integer "${CONDUCTOR_PORT:-}"; then
    PORT="${PORT:-$(unused_port_in_block "$((CONDUCTOR_PORT + 1))" "$((CONDUCTOR_PORT + RESERVED_BLOCK_SIZE - 1))" " ${VITE_PORT:-} ")}"
  else
    PORT="${PORT:-3000}"
  fi
  POSTGRES_HOST_BIND="${POSTGRES_HOST_BIND:-127.0.0.1}"
  POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-$(default_postgres_port)}"
  POSTGRES_DB="${POSTGRES_DB:-agent_context}"
  POSTGRES_USER="${POSTGRES_USER:-agent_app}"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-agent_app}"
  DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT}/${POSTGRES_DB}}"
}

print_env() {
  load_env
  printf 'VITE_PORT=%s\n' "$VITE_PORT"
  printf 'PORT=%s\n' "$PORT"
  printf 'POSTGRES_HOST_BIND=%s\n' "$POSTGRES_HOST_BIND"
  printf 'POSTGRES_HOST_PORT=%s\n' "$POSTGRES_HOST_PORT"
  printf 'POSTGRES_DB=%s\n' "$POSTGRES_DB"
  printf 'POSTGRES_USER=%s\n' "$POSTGRES_USER"
  printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
  printf 'DATABASE_URL=%s\n' "$DATABASE_URL"
}

export_env() {
  load_env
  export VITE_PORT PORT POSTGRES_HOST_BIND POSTGRES_HOST_PORT POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL
}

case "${1:-env}" in
  env)
    print_env
    ;;
  exec)
    shift
    if [ "${1:-}" = "--" ]; then
      shift
    fi
    export_env
    exec "$@"
    ;;
  *)
    echo "usage: scripts/local-env.sh [env|exec -- command]" >&2
    exit 2
    ;;
esac
