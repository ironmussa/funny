# Proposal

## Why

Today a runner is authorized at the **user** level: any runner owned by a user can serve, read and write any of that user's projects, and the resolver falls back to "any reachable runner of the user" when the expected one is offline. To run each project (often a different client) on its own remote compute, the runner↔project relationship must become an explicit authorization boundary — a runner must never touch a project it was not assigned to, unless the project's settings allow it. This is a prerequisite for `provision-railway-runners` but is valuable on its own.

## What Changes

- Introduce two runner roles: **general** (one per user, configurable; serves projectless and non-overridden work — today's behavior) and **dedicated** (bound to one or more projects through explicit assignments).
- A project uses the user's general runner by default and MAY override it with a dedicated runner from **Project Settings**. Additional runners can be granted access to a project only from that project's settings.
- Routing: a project with a dedicated runner routes ONLY to its assigned runner(s). If none is reachable the request fails with a clear "project runner offline" error — no fallback to the general runner or to any other runner. A dedicated runner is never chosen as a fallback for anything else.
- **BREAKING (internal)**: the runner→server data channel authorizes every operation against the runner's project assignments (in addition to the existing user check). A dedicated runner cannot read or mutate threads, messages, tool calls, comments, queues or projects outside its assignments; listings are filtered to assigned projects.
- Projectless operations — scratch threads, filesystem browsing (`/api/browse`), adding a local project, user-level GitHub routes — run only on the general runner.
- Server→runner pushes (events, settings, credentials) to a dedicated runner are limited to its assigned projects. User-level settings (providers, MCP, skills, permission rules) are still delivered so a dedicated runner behaves exactly like the general one within its scope.
- Per-project git credential override: a project MAY define its own GitHub credential; otherwise it inherits the user's. Credentials keep being delivered per operation and are never stored in runner environment variables. The UI warns when a dedicated runner inherits the user's personal token.
- Revoking a runner's access to a project terminates its active sessions for that project; files/worktrees on the runner's disk are left in place.
- `resolveAnyRunner` (unauthenticated MCP OAuth callbacks) is restricted so it can never land on a dedicated runner of an unrelated project.

## Capabilities

### New Capabilities

- `project-runner-binding`: runner roles (general/dedicated), project-level runner override and access grants, isolation-preserving routing, project-scoped data-channel authorization, projectless-work placement, and project-level git credential inheritance.

### Modified Capabilities

<!-- None: runner-grpc-transport already requires identity to come from authenticated credentials; this change adds a new authorization layer on top without changing transport requirements. -->

## Impact

- Server: `services/runner-resolver.ts`, `services/runner-manager.ts`, `services/data-handler.ts` (`assertDataOwnership` and listings), proxy middleware, project settings API, credential delivery, schema (`runners.role`, user default general runner, project runner override, project git credential).
- Shared: DB schema + migrations (SQLite and Postgres), repository updates.
- Client: Project Settings "Runner" and "Git credentials" sections, user Settings "General runner", offline-runner error state.
- Runtime: no protocol change; must tolerate rejected data operations with a clear error.
- Tests: tenant/project isolation vertical tests extending the existing isolation suite.
