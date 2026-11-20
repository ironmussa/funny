# Tasks

## 1. Data model

- [x] 1.1 Add `projectSandboxSettings` to `packages/shared/src/db/schema.sqlite.ts` and `schema.pg.ts` (same columns, primary key `(project_id, user_id)`) and verify `bun run typecheck` passes
- [x] 1.2 Add migration `090_project_sandbox_settings` to `packages/server/src/db/migrate.ts` and verify a fresh SQLite DB in the server test setup has the table

## 2. Server: settings service and routes

- [x] 2.1 Implement `ProjectSandboxSettingsService` (`get`, `save`, `clear`, `forThread`) with owned-project, owned-connection and size validation; verify with unit tests covering save, default size, foreign connection, unknown size, project not owned and clear
- [x] 2.2 Delete a connection's project settings in `InfraConnectionService.remove`; verify with a test that removing a connection clears the projects using it
- [x] 2.3 Add `GET | PUT | DELETE /api/infra/projects/:projectId/sandbox` to `routes/infra.ts` with audit records for save/clear; verify with route tests (200 `{ settings: null }`, 404 foreign project/connection, 400 unknown size)

## 3. Server: thread creation

- [x] 3.1 Make `sandbox` / `sandbox.connectionId` optional in `sandbox-thread.ts` and resolve the project configuration through a new `projectSandbox` dep; verify `sandbox-thread.test.ts` covers project-configured creation, explicit connection, and `409 project-sandbox-not-configured`
- [x] 3.2 Wire `projectSandbox` in `sandbox-thread-wiring.ts` and verify `bun test packages/server/src/__tests__/services/thread-sandboxes` passes

## 4. Client: data layer and project settings

- [x] 4.1 Add `infraApi.getProjectSandbox / saveProjectSandbox / clearProjectSandbox` and the `projectSandboxQuery` + `useProjectSandbox` hook + actions in `data/runner/`; invalidate project sandbox queries when a connection is removed; verify with a data-layer test
- [x] 4.2 Add the Sandbox section (connection, size, enabled-by-default, link to Settings > Sandboxes when there are no connections) to the project settings with `data-testid`s; verify with a component test

## 5. Client: composer

- [x] 5.1 Remove the per-connection entries from `buildRuntimeModes` and the `sandbox:<id>` choice parsing; update `thread-payload` so a sandbox thread sends `runtime: 'sandbox'` without a connection; verify `thread-payload.test.ts`
- [x] 5.2 Add `sandboxEnabled` to `use-prompt-model-state` (initialised from the project configuration, reset on project change, never for scratch) and the `prompt-sandbox-toggle` button in the footer; verify with `PromptInputUI` submit tests (toggle on → sandbox payload, off → selected runtime, not configured → no toggle)

## 6. Integration

- [x] 6.1 Run `bun run lint`, `bun run typecheck` and the client and server test suites; verify all pass and `fallow audit` reports no introduced findings
