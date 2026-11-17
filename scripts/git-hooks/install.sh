#!/usr/bin/env sh
# Installs the git hooks declared in lefthook.yml. Run by `bun install`
# through the root `prepare` script.
#
# Skipped outside a git checkout (Docker / Railway builds) and when
# devDependencies are not installed (production installs).

git rev-parse --git-dir >/dev/null 2>&1 || exit 0
[ -x node_modules/.bin/lefthook ] || exit 0

# Clones set up before the move from husky still point core.hooksPath at
# husky's directory, which would keep git from running lefthook's hooks.
if [ "$(git config --local --get core.hooksPath)" = ".husky/_" ]; then
  git config --local --unset core.hooksPath
fi

node_modules/.bin/lefthook install ||
  echo "warning: lefthook could not install the git hooks; run 'bunx lefthook install' to see why." >&2
