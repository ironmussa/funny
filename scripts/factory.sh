#!/usr/bin/env bash
# Start the issue factory with its secrets file, from the funny checkout:
#   bun run factory [-- --config ./factory.yaml]
# The secrets file (default $FUNNY_FACTORY_HOME/secrets.env, else
# ~/.funny/factory/secrets.env) is sourced only into this process, never into
# funny's .env, and refused when anyone but its owner can read it. Without the
# file, the orchestrator reads the environment or asks on the terminal.
set -euo pipefail

home="${FUNNY_FACTORY_HOME:-$HOME/.funny/factory}"
secrets="${FUNNY_FACTORY_SECRETS:-$home/secrets.env}"

if [ -f "$secrets" ]; then
  if [ -n "$(find "$secrets" \( -perm -004 -o -perm -040 \) -print)" ]; then
    echo "Refusing $secrets: it is readable by others (run: chmod 600 \"$secrets\")" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$secrets"
  set +a
fi

cd "$(dirname "$0")/.."
exec bun packages/agent/src/bin/orchestrator.ts start "$@"
