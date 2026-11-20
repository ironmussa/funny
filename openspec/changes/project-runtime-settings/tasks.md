# Tasks

## 1. Schema + migration (phase 1)

- [x] 1.1 Add `mode: text('mode').notNull().default('local')` and drop `enabledByDefault` on `projectSandboxSettings` in `schema.sqlite.ts` and `schema.pg.ts` (mirrored). Physical table and symbol kept (see design decision 1).
- [x] 1.2 Add migration `095_project_runtime_mode` in `db/migrate.ts`: ADD `mode`, backfill `mode = enabled_by_default ? 'sandbox' : COALESCE(projects.default_mode, 'local')`, DROP `enabled_by_default` (in place, both dialects).
- [x] 1.3 Audited every `project_sandbox_settings` / `projectSandboxSettings` reference; `data-scope.ts` does not reference the table by name, so no rule change. Updated the test-db helper table shape.
- [x] 1.4 Added `project-runtime-mode-migration.test.ts`: `enabled_by_default=1` → `mode='sandbox'`; `0` → `projects.default_mode` (or `local` when null).

## 2. Service (phase 1)

- [x] 2.1 Added `mode` to `ProjectSandboxView` and `mode: ThreadRuntimeMode` to `SaveProjectSandboxInput`, replacing `enabledByDefault` (service file name kept for now).
- [x] 2.2 Connection-owner and size checks run only when `mode='sandbox'`; `local`/`worktree` skip them and preserve a non-null `connection_id`/`size_id`.
- [x] 2.3 Scoping widened to project ACCESS: `requireOwnedProject` → `requireProjectAccess` (owner or `project_members`), so any member reads/writes their own runtime row (phase 2a). A foreign connection is still refused as not-found; added a member-access test.
- [x] 2.4 Updated the service tests for `mode` and added local-runtime + sandbox-requires-connection + member-access cases.
- [x] 2.5 Migration `096_seed_owner_worktree_runtime`: seed a runtime row for the owner of every project whose `default_mode='worktree'` and that has no row, so existing worktree defaults survive the switch to "no row = local". Members still get no row.

## 3. Composer + UI (phase 2a)

- [x] 3.1 `ProjectThreadModeSetting.tsx`: reads/writes the user's runtime row (Local · Worktree · Sandbox); offered to every member for local/worktree, sandbox owner-only (and disabled without a connection). No longer takes `defaultMode`/`onModeChange`.
- [x] 3.2 The composer reads the caller's runtime row via `useProjectThreadMode(projectId)` at the three `project.defaultMode` origins (`use-prompt-thread-context.ts`, `NewThreadInput.tsx`, `mobile/NewThreadView.tsx`); sandbox still via `useSandboxToggle` (= `mode==='sandbox'`).
- [x] 3.3 Stopped writing `projects.default_mode` from the thread-mode UI (`GeneralSettings.tsx` no longer passes `onModeChange`); the column stays for now.
- [x] 3.4 Updated the client tests for the per-user control, member access, and absent-row ⇒ local.

### 3b. Sandbox for non-owner members (phase 2b)

- [x] 3b.1 Server: the sandbox-thread launcher gate `findOwnedProject` → `findAccessibleProject` (owner or `project_members`) in `sandbox-thread-wiring.ts`. Safe: the per-thread GitHub App token is capped by the LAUNCHER's own access (`threads.userId`, `github-app/sandbox-tokens`) and the sandbox runs on the launcher's own connection, so a member never exceeds their own reach.
- [x] 3b.2 Client: `ProjectSandboxSetting` and `ProjectThreadModeSetting` drop the owner-only gating (and the `ownerId` prop); every member configures their own connection and may pick sandbox. Tests updated.

## 4. Factory (phase 3 — later)

- [ ] 4.1 When the factory starts a thread, resolve the enabler's runtime row and pass its `mode`/connection into creation; fall back to `local` when absent.

## 5. Retire default_mode as a source (phase 4)

- [x] 5.1 Removed the web client's remaining `project.defaultMode` runtime reads: the live `KanbanView` slide-up origin now uses `useProjectThreadMode`, and the two dead reads (`composeProjectDefaults`, `resolveModeDefaults`) that my 2a override shadowed are gone.
- [x] 5.2 Kept the `projects.default_mode` column: the Chrome extension still reads it as its project-level default (`popup.ts`, `content.ts`, `api.ts`), so dropping it is out of scope. Annotated both schema dialects as legacy / extension-only.

## 6. Verification

- [ ] 6.1 `bun run lint` and `bun run typecheck` green.
- [ ] 6.2 `bun run format` (oxfmt) on touched files.
- [ ] 6.3 `openspec validate project-runtime-settings --strict` passes.
