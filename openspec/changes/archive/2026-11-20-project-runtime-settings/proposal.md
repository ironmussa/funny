# Proposal

## Why

Where a project's threads run — local, worktree, or sandbox — is split across two
sources today: the mode (local/worktree) lives on `projects.default_mode`, one value
shared by every member, while the sandbox choice (connection, size, "on by default")
lives in `project_sandbox_settings`, keyed per `(project, user)`. A member who wants
sandbox toggles a per-user switch, but the mode stays project-wide, so the control is
half shared and half personal — and the issue factory (ADR 0002) needs one coherent
"runtime for this person on this project" to run as whoever enabled it.

## What Changes

- Consolidate the thread runtime into a single per-`(project, user)` row: `local`,
  `worktree`, or `sandbox` (with a provider connection and size). Each member chooses
  independently for the same project; with no row the runtime is `local`.
- Reuse `project_sandbox_settings`, renamed to `project_runtime_settings`, adding a
  `mode` column and **removing `enabled_by_default`** — `mode = 'sandbox'` replaces it.
- **BREAKING (data):** migrate every existing row with
  `mode = enabled_by_default ? 'sandbox' : (projects.default_mode ?? 'local')`.
- The web composer and the issue factory read the caller's runtime row instead of
  `projects.default_mode`. `projects.default_mode` stays as a column but stops being
  the runtime source; its retirement is deferred to avoid churning its ~38 other
  type-level references in one change.
- Phased delivery: (1) schema + service + migration, (2) composer read/write and the
  `ProjectThreadModeSetting` UI, (3) the factory uses the enabler's runtime, (4) retire
  `projects.default_mode` as a source (cleanup).

## Capabilities

### New Capabilities

- `project-runtime-settings`: each user's thread runtime (local | worktree | sandbox,
  with the sandbox connection and size) for a given project, keyed per `(project,
  user)`, defaulting to local; the source the composer and the factory read to decide
  where a new thread runs.

### Modified Capabilities

<!-- None: no existing spec documents project default mode or sandbox settings as requirements. -->

## Impact

- **Schema (`packages/shared`):** rename `project_sandbox_settings` →
  `project_runtime_settings`, add `mode`, drop `enabled_by_default`; migration in
  `db/migrate.ts` (both sqlite and pg mirrors).
- **Server (`packages/server`):** `project-sandbox-settings.ts` service gains `mode`
  on its view and save input; the migration backfills existing rows.
- **Client (`packages/client`):** `ProjectThreadModeSetting.tsx` (already drafted) and
  `use-prompt-model-state.ts` read/write the runtime row instead of
  `project.defaultMode` + the sandbox toggle.
- **Factory (future):** reads the enabler's runtime row; out of scope for phase 1–2.
- No change to runner isolation, gRPC, or Socket.IO.
