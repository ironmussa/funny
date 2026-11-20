# anti-slop (vendored)

- Source: https://github.com/dmmulroy/anti-slop (MIT)
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13)
- Copied from `skills/install-anti-slop/assets/anti-slop/` with the `install-anti-slop`
  skill (`scripts/install.mjs`). It matches upstream `src/` at that commit, without the
  `*.test.ts` files.
- Entry points registered in `oxlint.config.ts`: `index.ts` (`anti-slop`) and
  `effect/index.ts` (`anti-slop-effect`; the repo depends on `effect` directly).
- `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.

## Local deviations

- None in the plugin source.
- Configuration: the rules start at `warn` instead of the upstream recommendation of
  `error`, while the existing findings are cleaned up; see `oxlint.config.ts`.
