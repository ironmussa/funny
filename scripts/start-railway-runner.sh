#!/bin/sh
set -eu

# Railway volumes may be owned by root, including state from older deployments.
# Prepare that state before dropping privileges for the runtime and its agents.
export FUNNY_DATA_DIR="${FUNNY_DATA_DIR:-/data}"
case "$FUNNY_DATA_DIR" in
  /*) ;;
  *) echo 'FUNNY_DATA_DIR must be an absolute path' >&2; exit 1 ;;
esac
if [ "$FUNNY_DATA_DIR" = / ]; then
  echo 'FUNNY_DATA_DIR must not be /' >&2
  exit 1
fi
runner_home="$FUNNY_DATA_DIR/home/funny"

if [ "$(id -u)" = 0 ]; then
  if ! id funny >/dev/null 2>&1; then
    useradd --user-group --home-dir "$runner_home" --shell /bin/sh funny
  fi
  mkdir -p "$runner_home"
  # Fix ownership once: the volume holds worktrees, scratch dirs and the
  # runner's $HOME, so a recursive chown on every boot grew with its size.
  # After the first full pass only the runtime (as funny) writes here, so later
  # boots just fix the top-level dirs. Delete the marker to force a full pass.
  ownership_marker="$FUNNY_DATA_DIR/.funny-ownership-v1"
  if [ -f "$ownership_marker" ]; then
    chown funny:funny "$FUNNY_DATA_DIR" "$FUNNY_DATA_DIR/home" "$runner_home"
  else
    # Only touch entries with the wrong owner (no inode writes for the rest).
    find "$FUNNY_DATA_DIR" \( ! -user funny -o ! -group funny \) -exec chown -h funny:funny {} +
    touch "$ownership_marker"
    chown funny:funny "$ownership_marker"
  fi
  # setpriv preserves provider and runner environment variables and forwards signals.
  exec setpriv --reuid=funny --regid=funny --init-groups \
    env HOME="$runner_home" USER=funny LOGNAME=funny sh "$0" "$@"
fi

mkdir -p "$FUNNY_DATA_DIR"
rm -f "$FUNNY_DATA_DIR/pty-daemon.pid" "$FUNNY_DATA_DIR/pty.sock"
git --version
cd "$(dirname "$0")/../packages/runtime"
exec bun run start
