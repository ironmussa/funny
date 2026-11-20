# Proposal

## Why

Sandbox provider connections (Boat, InstaBox, …) are global to the user, and the composer lists every one of them as a separate runtime for every thread in every project. There is no way to say "this project runs in my InstaBox account at this size", so each thread has to pick a connection by hand and always starts on `Local`. Projects need their own sandbox choice, and a new thread should simply turn that sandbox on or off.

## What Changes

- Each user can configure **one sandbox per project**: which of their own provider connections to use, the machine size, and whether new threads start with the sandbox on. The setting is per user and per project, so in a shared project nobody runs machines on another member's account.
- A **Sandbox** section in the project settings to choose, change or clear that configuration.
- The composer shows a **sandbox on/off toggle** for a new thread when the current user has a sandbox configured for the project; it starts at the configured default.
- **BREAKING (UI):** the composer no longer lists every provider connection as a `Sandbox · <label>` runtime. The runtime selector only offers `Local` and, when the project has a launcher, `Remote`.
- Creating a sandbox thread without naming a connection uses the caller's project sandbox (connection and size). The server, not the client, resolves the connection, and refuses it when the project has none configured for the caller.
- Deleting a provider connection removes the project sandbox settings that use it.

## Capabilities

### New Capabilities

- `project-sandbox-settings`: per-user, per-project sandbox configuration (connection, size, default on/off), how it is managed, how it drives sandbox thread creation, and how the composer exposes it.

### Modified Capabilities

None. The sandbox thread creation rules live in the in-flight `thread-sandboxes` change, not yet in `openspec/specs/`; this change only adds how the connection is chosen.

## Impact

- **Database:** new `project_sandbox_settings` table (SQLite and Postgres schemas, migration `090`).
- **Server:** `GET / PUT / DELETE /api/infra/projects/:projectId/sandbox`; sandbox thread creation (`POST /api/threads` with `runtime: 'sandbox'`) resolves the project sandbox when no connection is given; removing a connection clears its project settings.
- **Client:** project settings (Sandbox section), the data layer (project sandbox query + actions), the composer (toggle replaces the per-connection runtime list), thread payload building.
- No runner, protocol or provider adapter changes.
