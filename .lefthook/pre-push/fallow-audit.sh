#!/bin/sh
# Pre-push fallow audit: blocks the push when the pushed commits introduce
# findings (verdict `fail`; `gate=new-only`, so inherited findings never block).
# It runs in the git hook, so every agent and every human push gets it, not only
# one harness.
#
# Git passes "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin.
# The audit reads the diff of the commits each ref adds: remote sha..local sha,
# or merge-base with origin/master for a new branch. A runtime error of fallow
# itself does not block (it is reported), the same as the old agent gate.
# Skip once with LEFTHOOK_EXCLUDE=fallow-audit git push, or LEFTHOOK=0.
set -u

PATH="$HOME/.bun/bin:$PATH"
export PATH

if [ -x ./node_modules/.bin/fallow ]; then
  FALLOW=./node_modules/.bin/fallow
else
  echo "fallow-audit: fallow is not installed (run bun install), skipping." >&2
  exit 0
fi

ZERO=0000000000000000000000000000000000000000
DIFF="$(mktemp)"
OUT="$(mktemp)"
trap 'rm -f "$DIFF" "$OUT"' EXIT

while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "${local_sha:-}" ] || continue
  # A deleted ref pushes no code.
  [ "$local_sha" = "$ZERO" ] && continue
  if [ "$remote_sha" = "$ZERO" ]; then
    base="$(git merge-base origin/master "$local_sha" 2>/dev/null || true)"
  else
    base="$remote_sha"
  fi
  [ -n "$base" ] || continue
  git diff "$base" "$local_sha" >>"$DIFF" 2>/dev/null || true
done

if [ ! -s "$DIFF" ]; then
  exit 0
fi

"$FALLOW" audit --quiet --explain --diff-file "$DIFF" >"$OUT" 2>&1
status=$?

case "$status" in
  0) ;;
  1)
    # Exit 1 is the `fail` verdict.
    cat "$OUT" >&2
    echo "fallow-audit: the pushed commits add findings; fix them (\`fallow explain <issue-type>\`)." >&2
    exit 1
    ;;
  *)
    echo "fallow-audit: fallow audit exited $status (runtime error), skipping:" >&2
    sed -n '1,5p' "$OUT" >&2
    ;;
esac
exit 0
