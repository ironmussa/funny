#!/bin/sh
# Build the runner for deployment (Railway `build:runner-deploy`).
#
# Compiles @funny/native-git (gitoxide) BEFORE bundling the runtime: Bun.build
# copies the .node binary into packages/runtime/dist only if it exists at bundle
# time. Without it the runner silently falls back to the git CLI, which spawns
# several git processes per status read.
#
# A missing native build fails the deploy. Set FUNNY_NATIVE_GIT_OPTIONAL=1 to
# deploy with the CLI fallback anyway (the runner then warns at startup).
set -eu

cd "$(dirname "$0")/.."

native_optional() {
  [ "${FUNNY_NATIVE_GIT_OPTIONAL:-}" = 1 ]
}

fail_native() {
  if native_optional; then
    echo "WARNING: $1; continuing with the git CLI fallback (FUNNY_NATIVE_GIT_OPTIONAL=1)" >&2
    return 0
  fi
  echo "ERROR: $1. Set FUNNY_NATIVE_GIT_OPTIONAL=1 to deploy without gitoxide." >&2
  exit 1
}

build_native() {
  if ! command -v cargo >/dev/null 2>&1; then
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo not found; installing a minimal Rust toolchain with rustup"
    command -v curl >/dev/null 2>&1 || { fail_native "curl is required to install Rust"; return 1; }
    rustup_init="$(mktemp)"
    # Download first: piping curl into sh would report success on a failed download.
    if ! curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$rustup_init" ||
      ! sh "$rustup_init" -y --profile minimal --default-toolchain stable --no-modify-path ||
      [ ! -f "$HOME/.cargo/env" ]; then
      rm -f "$rustup_init"
      fail_native "rustup install failed"
      return 1
    fi
    rm -f "$rustup_init"
    . "$HOME/.cargo/env"
  fi
  command -v cc >/dev/null 2>&1 || { fail_native "a C linker (cc) is required to build native-git"; return 1; }

  bun run build:native || { fail_native "native-git build failed"; return 1; }
  (cd packages/native-git && bun -e "if (require('./index.js').ping() !== 'pong') process.exit(1)") ||
    { fail_native "native-git was built but does not load"; return 1; }
}

native_ok=1
build_native || native_ok=0

bun run --cwd packages/runtime build

if [ "$native_ok" = 1 ] && ! ls packages/runtime/dist/native-git.*.node >/dev/null 2>&1; then
  fail_native "the runtime bundle does not contain the native-git binary"
fi
