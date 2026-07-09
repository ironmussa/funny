# Development workflow

## Setup and running

```bash
bun install

# Everything at once: server (3001) + runner/runtime (dev-watch) + client (5173, Vite) + scheduler
bun run dev

# Individually
bun run dev:server       # cd packages/server && bun --watch src/index.ts
bun run dev:runtime       # packages/runtime/src/dev-watch.ts
bun run dev:client        # cd packages/client && npx vite
bun run dev:scheduler     # packages/scheduler/src/bin/scheduler.ts, --watch
bun run dev:api-acp       # packages/api-acp, --watch (standalone service, see integrations page)
```

**Agent safety rule — do not violate this in an automated session:** never run `bun run dev`, any `--watch` command, or `vite` directly. These are long-running dev servers; running them headlessly hangs the session and can interfere with the human's own dev server via `kill-port.ts`. To verify a change compiles, use:

```bash
bun run build         # builds client, then runtime, then server
bun run typecheck      # baseline-diff type check (see below) — not raw tsc
bun --check packages/runtime/src/index.ts   # type-check a single file
```

Production start: `bun start` (runs `bin/funny.js` against built `dist/` output). Database: `bun run db:push` / `bun run db:studio` (Drizzle, proxied to `packages/runtime`).

## TypeScript

Bun ships its own TypeScript checker — don't install or invoke `tsc`/`typescript` directly. Root `tsc --noEmit` on this repo is a known false positive; the canonical check is:

```bash
bun run typecheck
```

This runs `scripts/fitness/check-typecheck.ts`, a **baseline-diff** check: it compares current type errors against a committed baseline (`.fitness/typecheck-baseline.txt`) so pre-existing debt doesn't block CI while new violations do. Use `bun run typecheck:refresh` only when you've deliberately reduced (never increased) the baseline.

## Lint, format, and architecture guardrails

```bash
bun run lint            # oxlint . + all fitness:*-validation checks below
bun run lint:fix        # oxlint --fix .
bun run format           # oxfmt --write .      (NOT prettier — no config here, wrong defaults)
bun run format:check     # oxfmt --check .
```

`bun run lint` also runs four baseline-diff "boundary validation" fitness checks (unvalidated HTTP/JSON/query/socket boundaries), each with matching `:refresh` and `:self-test` variants: `fitness:boundary-validation`, `fitness:query-validation`, `fitness:socket-validation`, `fitness:json-validation` (`scripts/fitness/check-*-boundary-validation.ts`).

Separately, `bun run fitness` runs the architecture-shape guardrails described in `scripts/fitness/README.md` and enforced against `ARCHITECTURE_EVAL.md`-style rules:

- `fitness:layering` — package dependency direction (e.g. `server` cannot import `runtime`; `core` cannot import `hono`/`drizzle-orm`; `shared` cannot import `core`/`runtime`).
- `fitness:circular` — no file-level circular imports.
- `fitness:size` — per-file line-count ceiling, with tracked waivers.
- `fitness:growth` — blocks PRs that grow already-oversized files further.

All of these are baseline-diff style (compare against `.fitness/*-baseline.txt`), following the project convention: freeze existing debt, block new violations. `AGENTS.md` in this repo requires `bun run lint` and `bun run typecheck` before considering any change complete.

## Testing

- **Unit/integration:** `vitest` for `core`/`runtime`/`client`-style packages, plain `bun test` (`bun:test`) for `shared`-style packages. Run via each package's own `package.json` `test` script, or `bun scripts/run-tests.ts` from the root.
- **End-to-end:** Playwright, driven by `bun run test:e2e` (`bunx playwright test`) / `bun run test:e2e:ui`. The full data-testid reference and per-feature test checklist lives in [`e2e/TEST-PLAN.md`](../../e2e/TEST-PLAN.md); spec files live in `e2e/*.spec.ts` (auth, sidebar, kanban, browser-panel, automation-inbox, i18n, dark-mode, accessibility, multi-tab, and more).
- **Regression rule:** when fixing a bug, add a test that fails without the fix and passes with it (per `CLAUDE.md` "Bug Fixes & Regression Tests"). If a test genuinely isn't feasible, say so explicitly rather than skipping silently.
- **UI testid convention:** every interactive element needs a `data-testid` in kebab-case, `{area}-{element}-{qualifier}` (e.g. `sidebar-add-project`, `thread-item-{id}`) — this is what the E2E suite above depends on.

## CI

`.github/workflows/`: `ci.yml` (lint + format-check + test, on push/PR to `master`, Bun **canary** channel is intentional while validating Bun 1.4/Rust builds), plus `e2e.yml`, `security.yml`, `build.yml`, `docs.yml` (VitePress docs at `docs/`, via `bun run docs:dev`/`docs:build`), `link-check.yml`, and `native-git.yml` (builds/tests the Rust `packages/native-git` addon across platforms).

## Error handling convention (`neverthrow`)

- **Required** in `packages/core/**` — every fallible function returns `Result<T, E>` / `ResultAsync<T, E>`; no raw `throw` in new core code.
- **Required at service-method boundaries** in `packages/runtime/src/services/**` and `packages/server/src/services/**` — public methods return `Result`/`ResultAsync` so callers can compose failure handling.
- **Allowed to throw:** Hono route handlers, top-level entry points (`src/index.ts`), test code, and third-party libraries (wrap at the boundary with `Result.fromThrowable`/`ResultAsync.fromPromise`).
- **Client code:** preferred, not required.
- On the server, `result-response.ts` converts `Result` values into HTTP responses.

## UI conventions (packages/client only)

All UI work must use shadcn/ui + Tailwind (Radix primitives) — never hand-roll buttons/dialogs/dropdowns that shadcn already provides, and never pull in another component library. Compose classes with the `cn()` helper (`@/lib/utils`), never raw string concatenation. Text sizing must scale with the user's Settings > Appearance font-size setting via the `*_FONT_SIZE_PX` maps in `@/stores/settings-store` (diffs/editor share one scale, prose/chat and inline code use denser scales) — never hardcode pixel font sizes. Components must use theme CSS variables (`hsl(var(--foreground))`, `bg-card`, etc.), never hardcoded colors, so light/dark both work. See the in-repo `CLAUDE.md` "UI Rules" section for the full list of installed shadcn components and the `data-testid` naming convention.
