#!/bin/sh
# Exercise the real privilege transition in an isolated Debian container.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
docker run --rm -i -v "$repo_dir:/repo:ro" node:22-bookworm sh -s <<'CONTAINER'
set -eu
mkdir -p /app/scripts /app/packages/runtime /data
cp /repo/scripts/start-railway-runner.sh /app/scripts/
printf 'persistent-state' > /data/runner-credentials.json
touch /data/pty-daemon.pid /data/pty.sock
cat > /usr/local/bin/bun <<'BUN'
#!/bin/sh
set -eu
test "$(id -u)" != 0
test "$USER" = funny
test "$HOME" = /data/home/funny
test -w "$HOME"
test -w /data/runner-credentials.json
test "$(cat /data/runner-credentials.json)" = persistent-state
test ! -e /data/pty-daemon.pid
test ! -e /data/pty.sock
test "$PWD" = /app/packages/runtime
test "$1 $2" = 'run start'
test "$RUNNER_TEST_ENV" = preserved
touch "$HOME/provider-auth"
BUN
chmod +x /usr/local/bin/bun
export RUNNER_TEST_ENV=preserved
sh /app/scripts/start-railway-runner.sh
# Repeated starts keep the same identity and persistent home.
sh /app/scripts/start-railway-runner.sh
test -f /data/home/funny/provider-auth
if FUNNY_DATA_DIR=/ sh /app/scripts/start-railway-runner.sh; then
  echo 'Expected an invalid data directory to be rejected' >&2
  exit 1
fi
echo 'Railway runner startup checks passed'
CONTAINER
