#!/bin/sh
# Lefthook runs this as a script job, not a `run` command: a `run` job with no
# file filters is skipped when HEAD has no files to push against @{push}
# ("no matching push files"), so pushing another branch, or
# FUNNY_PREPUSH_ALL=1, never reached the suites. Git passes the pushed refs on
# stdin; scripts/pre-push.ts reads them to pick the suites.
PATH="$HOME/.bun/bin:$PATH"
export PATH
exec bun run test:pre-push
