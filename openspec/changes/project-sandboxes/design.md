# Design

## Context

Builds on the in-flight `thread-sandboxes` change. Relevant current state:

- `infra_connections` rows belong to one user and hold that user's encrypted provider credential. `InfraConnectionService.providerFor(userId, connectionId)` already scopes every connection read to its owner.
- Sandbox threads are created by the server (`sandbox-thread.ts`): `POST /api/threads` with `runtime: 'sandbox'` and `sandbox: { connectionId, sizeId? }`. The project must be **owned** by the caller (`findOwnedProject`).
- The composer builds its runtime options in `buildRuntimeModes` (`lib/thread-payload.ts`): `Local`, `Remote` (launcher) and one `sandbox:<connectionId>` entry per connection; the choice always starts at `Local`.
- Projects can belong to an organization, so several users can work in one project.

## Goals / Non-Goals

**Goals:**

- One sandbox configuration per (user, project), owned and resolved server-side.
- The server is the source of truth for which connection a project thread uses; the client only says "sandbox on".
- Keep the explicit `connectionId` path working (the infra provision route and API callers use it).

**Non-Goals:**

- Sandbox threads for organization members in projects they do not own (creation stays owner-only, as today). The table is keyed by user so this can be added later without a migration.
- A per-thread choice among several connections.
- Org-wide or shared sandbox connections.

## Decisions

### A per-user table, not columns on `projects`

`project_sandbox_settings (project_id, user_id, connection_id, size_id, enabled_by_default, updated_at)`, primary key `(project_id, user_id)`, `project_id` referencing `projects` with `ON DELETE CASCADE`.

- _Alternative:_ columns on `projects`. Rejected: in an org project every member would launch machines on whoever configured it, crossing a credential and billing boundary.
- `connection_id` is not a cascading foreign key; the connection service deletes the rows when it removes a connection. This keeps the rule in one place for both dialects and works whether or not SQLite foreign-key enforcement is on.

### Settings live under `/api/infra`

`GET | PUT | DELETE /api/infra/projects/:projectId/sandbox`, next to the connection routes. A new `ProjectSandboxSettingsService` (server, `services/thread-sandboxes/project-sandbox-settings.ts`) returns `ResultAsync` and owns validation:

1. the project is owned by the caller,
2. the connection belongs to the caller (`providerFor`),
3. the size is one of the provider's `capabilities().sizes`; absent means `resolveSandboxSize`'s default.

`GET` answers `{ settings: null }` rather than 404 when nothing is configured, so the client's query caches "not configured" like any other value.

### Server-side resolution on thread creation

`createSandboxThreadSchema.sandbox` becomes optional and `connectionId` inside it optional. In `createSandboxThreadLauncher.create`: an explicit `connectionId` is used as today; otherwise the launcher asks a new dep, `projectSandbox(userId, projectId)`, for the configuration and uses its connection and size. No configuration → `409 project-sandbox-not-configured`. `prepareSandboxLaunch` still re-checks the connection through `providerFor`, so a stale or foreign id cannot slip through.

- _Alternative:_ the client reads the configuration and sends its `connectionId`. Rejected: it duplicates the rule and lets a stale client cache pick a deleted connection.

### Composer: a toggle beside the runtime selector

`buildRuntimeModes` drops the per-connection entries. A new `useProjectSandbox(projectId)` hook (data layer, `data/runner/`) reads the configuration and the connection label. `use-prompt-model-state` holds `sandboxEnabled`, initialised from `enabledByDefault` and re-initialised when the project changes. The footer renders a pressed-state `Button` (`data-testid="prompt-sandbox-toggle"`) when a configuration exists and the thread is not scratch. On submit, a pressed toggle sends `runtime: 'sandbox'` with no `connectionId`; `SubmitOpts.sandboxConnectionId` and the `sandbox:<id>` choice format go away.

- _Alternative:_ keep one `Sandbox · <label>` entry in the runtime selector. Rejected: the user asked for an on/off control, and a toggle keeps `Local`/`Remote` independent of the sandbox.

### Client data layer

`projectSandboxQuery(projectId)` on the shared `QueryClient` (request-shaped, no per-row writes), `saveProjectSandbox` / `clearProjectSandbox` actions that write the query data from the server response and toast on failure. Removing a connection in Settings > Sandboxes invalidates every project sandbox query. The Sandbox section lives in `general-settings-project/` and uses shadcn `Select` and a switch-style `Button`.

## Risks / Trade-offs

- [A connection is removed while a composer is open with the toggle on] → the server answers `409 project-sandbox-not-configured`; the composer shows the error toast and the invalidated query hides the toggle.
- [Users relying on picking a different connection per thread lose that] → change the project's sandbox; API callers can still pass `sandbox.connectionId`.
- [Org members see no toggle in projects they do not own] → expected (non-goal); the Sandbox section is only rendered for owned projects.

## Migration Plan

Additive migration `090_project_sandbox_settings` (CREATE TABLE IF NOT EXISTS, both dialects). No data to backfill: existing users configure their projects once. Rollback: the table is unused by the previous code.
