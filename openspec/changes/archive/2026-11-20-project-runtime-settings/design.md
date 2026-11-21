# Design

## Context

`project_sandbox_settings` already exists keyed per `(project_id, user_id)` with
`connection_id`, `size_id`, `enabled_by_default`, `updated_at` (see
`packages/shared/src/db/schema.sqlite.ts` and `.pg.ts`, mirrored). Its service is
`packages/server/src/services/thread-sandboxes/project-sandbox-settings.ts`
(`ProjectSandboxView`, `SaveProjectSandboxInput`), scoped to the owning user and
checking the connection's owner and the size against the provider.

The mode (`local`/`worktree`) lives separately on `projects.default_mode`, read by the
web composer (`packages/client/src/hooks/use-prompt-model-state.ts`) and passed into
thread creation (`packages/runtime/src/services/thread-service/create.ts`, which already
accepts `mode` and `runtime` on the request). `defaultMode` appears in ~41 files, but
almost all are the type threading through; the deciding reads are the composer and
creation.

Tables are created by raw SQL in `db/migrate.ts` (not drizzle migrations), so a rename +
backfill is a migration step there, mirrored for sqlite and pg.

## Goals / Non-Goals

**Goals:**

- One per-`(project, user)` row is the single source of a member's thread runtime.
- No data loss for existing sandbox settings on migration.
- Minimal surface: extend the existing table/service rather than add a parallel one.

**Non-Goals:**

- Removing `projects.default_mode` (deferred to phase 4; it keeps feeding its other
  readers until then).
- Building the issue factory (phase 3 consumes this; not built here).
- Team-shared or project-wide runtime, or opening sandbox to non-owners.

## Decisions

1. **Reuse the table in place.** Keep the physical table `project_sandbox_settings` and
   the drizzle symbol `projectSandboxSettings`; add a `mode` column and drop
   `enabled_by_default`. A physical rename to `project_runtime_settings` was considered
   and dropped: nothing outside schema/migrate/service references the table by name, so
   the rename was cosmetic churn (a SQLite table recreate) with no behavior gain. The
   capability name (`project-runtime-settings`) and the spec describe behavior, not the
   table name; a later cosmetic rename can follow if wanted. `connection_id`/`size_id`
   stay NOT NULL and are only meaningful when `mode='sandbox'` — a `local`/`worktree` row
   still needs a value, so the service writes the user's last connection (or `''`) and the
   readers ignore it unless `mode='sandbox'`. (Alternative: nullable columns — more
   dual-dialect churn for little gain.)

2. **Migration backfill, in place.** Migration `095_project_runtime_mode`: `ADD COLUMN mode
   TEXT NOT NULL DEFAULT 'local'`, then
   `UPDATE … SET mode = CASE WHEN enabled_by_default = 1 THEN 'sandbox' ELSE COALESCE(projects.default_mode, 'local') END`,
   then `DROP COLUMN enabled_by_default`. Both dialects support `ADD`/`DROP COLUMN` via the
   existing `ctx().addColumn`/`dropColumn` helpers (sqlite ≥ 3.35, pg native), so no table
   recreate is needed. The migration runner records `095` once, so it is naturally
   idempotent across boots.

3. **No seed from the project on read.** Absent row ⇒ `local`, full stop (per the spec).
   `projects.default_mode` is not consulted at read time; the only place it is read is the
   one-time migration backfill above.

4. **Service shape.** `ProjectSandboxView` gains `mode`; `SaveProjectSandboxInput`
   replaces `enabledByDefault: boolean` with `mode: 'local'|'worktree'|'sandbox'`. The
   existing connection-owner and size checks run only when `mode='sandbox'`. Rename the
   service symbols to `*Runtime*` for clarity, keeping the file's domain annotations.

5. **Phased, each phase green.** (1) schema+migration+service; (2) composer and
   `ProjectThreadModeSetting` read/write the row, stop writing `projects.default_mode`;
   (3) factory reads the enabler's row; (4) retire `default_mode` as a source.

## Risks / Trade-offs

- **Rename touches the data channel scope rules** (`data-scope.ts`) and any `data:*` type
  for sandbox settings — must be updated in lockstep or a read is refused. Audit
  `project_sandbox_settings` / `projectSandboxSettings` references before renaming.
- **`connection_id` NOT NULL for non-sandbox rows** is mildly awkward; accepted to avoid
  dual-dialect nullable churn. Revisit if it causes confusion.
- **Phase 2 leaves `projects.default_mode` written-by-nobody but still read** by ~38 other
  references until phase 4; during that window it is stale for runtime but harmless, since
  nothing reads it for runtime after phase 2.
- **Migration is one-way** (drops `enabled_by_default`); backup-free rollback would lose the
  flag. Acceptable: the value is reconstructable from `mode='sandbox'`.
