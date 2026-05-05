# Architecture Fitness Functions

Automated checks that guard the architectural properties called out in `ARCHITECTURE_EVAL.md`. Run them in CI on every PR and locally with `bun run fitness`.

| Script | Enforces |
|--------|----------|
| `check-layering.ts` | `server` does not import `runtime`; `core` does not import `hono` or `drizzle-orm`; `shared` does not import `core` or `runtime`. |
| `check-circular.ts` | No file-level circular imports within `core/src`, `runtime/src`, `server/src`, `client/src`. |
| `check-file-size.ts` | No source file over 1500 lines, except files on the explicit waiver list (each with a decomposition target). |
| `check-file-growth.ts` | No file already over 1500 lines may grow by more than 100 net lines in a single PR. Compares HEAD against `origin/master` (or `$BASE_REF`). |
| `check-typecheck.ts` | No NEW `tsc --noEmit` errors vs the frozen baseline at `.fitness/typecheck-baseline.txt`. Pre-existing errors stay tracked but don't block commits. Refresh the baseline with `bun run typecheck:refresh`. Wired into the pre-commit hook for any commit that touches `.ts`/`.tsx`. |

## Refreshing the typecheck baseline

When you fix a baseline error (or add a new file with intentional errors flagged for follow-up), refresh the baseline:

```bash
bun run typecheck:refresh
git add .fitness/typecheck-baseline.txt
```

Goal is for the baseline to shrink over time. PR reviewers should reject baseline growth without a stated reason.

## Adding a waiver

Edit `check-file-size.ts` and add an entry to `WAIVERS` with `{ current, target, note }`. The PR description MUST link to a decomposition plan. Waivers are expected to shrink — `target < current` is the norm.

## CI wiring

Add to your PR workflow:

```yaml
- run: bun run fitness
```

Or individual checks:

```yaml
- run: bun run fitness:layering
- run: bun run fitness:size
- run: bun run fitness:circular
- run: BASE_REF=origin/${{ github.base_ref }} bun run fitness:growth
```
