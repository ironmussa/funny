# Design

## Context

- `runner-resolver.ts` resolves in four strategies (thread cache → project assignment → thread registry → any runner of the user). Strategy 4 and `resolveAnyRunner` are the cross-project leak paths.
- `runner_project_assignments(runnerId, projectId, localPath)` is already many-to-many but is only a routing hint.
- `data-handler.ts::assertDataOwnership` authorizes runner data operations by `runnerUserId` only.
- Runner identity is derived from authenticated gRPC credentials (`runner-grpc-transport`), so the server always knows `runnerId` for a data operation — the new check needs no protocol change.
- Agent execution profiles already support a per-project binding (`getProjectBinding`), the model to mirror for git credentials.

## Goals / Non-Goals

**Goals:** make assignments authoritative in routing, data channel and server→runner pushes; general + per-project override model; keep laptop (general) behavior unchanged for projects without override.

**Non-Goals:** sandboxing inside a runner; GitHub App installation tokens; multi-user sharing changes (steer-share delegation keeps its own rules, resolved by thread owner — it now resolves to the owner's _project_ runner).

## Decisions

1. **Role column on `runners`** (`role: 'general' | 'dedicated'`, default `general`) plus `user_profiles.general_runner_id` as a _preference_. No backfill: every existing runner is general, so behavior is unchanged until a project is pinned. All general runners of a user remain eligible; the designated one is tried first. _Alternative_: infer role from "has assignments" — rejected, it makes a freshly provisioned runner briefly general and routable.
2. **Server-only tables instead of a `projects` column.** `project_runner_settings(project_id PK, dedicated_runner_id, github_token)` + `project_runner_grants(project_id, runner_id, granted_by)`. `runner_project_assignments` stays a LOCATION record only — runners write it themselves (`runner:assign_project`, auto-assign on `data:create_project`), so treating it as a grant would let a runner self-authorize. `dedicated_runner_id` has **no FK**: `purgeStaleRunners` deletes runners after 24h without heartbeat, and `ON DELETE SET NULL` would silently hand the project back to the general runner.
3. **Single rule module `runner-scope.ts`** with a pure `evaluateRunnerAccess(runner, policy)`: pinned or granted → yes; dedicated → no; general → yes unless the OWNER pinned the project (a collaborator's own general runner is unaffected). 30s cache, invalidated synchronously on writes; listeners clear the resolver's thread cache.
4. **Data channel**: `data-scope.ts` holds `DATA_SCOPE_RULES` (`refs` / `projectless` / `user` / `list`) for every `data:*` type; unknown types are refused (fail closed). `refs` resolves every referenced entity to its thread → project; `list` responses are filtered. A test enumerates the handler's `case` labels so a new type cannot ship without a rule. Rejections emit `runner.scope_denied`.
5. **Agent events**: `grpc/events-handler.ts` authorizes every event (and gap resync) with `canRunnerActOnThread` (thread owner = runner owner AND project in scope) before persisting or relaying. This also closed a pre-existing gap where events were relayed to a thread stream without an ownership check.
6. **Routing**: resolver computes the target (project, or projectless via the thread's `project_id`); pinned → `[dedicated, ...grants]` reachable or fail with `project-runner-offline`; otherwise candidates = thread's runner → runners holding a checkout → general runners, each filtered by scope. Strategy 4 ("any runner of the user") is gone; `findAnyRunnerForUser` and `resolveAnyRunner` return general runners only; scheduler dispatch routes by thread.
7. **Git credential override**: encrypted `project_runner_settings.github_token`. `GetGithubToken` gained an optional `project_id` (additive proto field); the server returns the project token when the requesting runner may access that project, else the user's PAT. A dedicated runner pinned to exactly one project gets that project's token even without naming it. Runtime git paths pass the thread's / route's project id (`resolveThreadIdentity`).
8. **Revocation without a new protocol command**: when a runner loses access (pin change or grant removal) the server stops that project's active threads on it via the existing `POST /api/threads/:id/stop` tunnel request; the scope cache is invalidated first, so data/events from the runner are refused immediately even if the stop is lost. Files stay on disk.
9. **UI**: one owner-only "Runner" tab in Project Settings holds the dedicated-runner select, grants, the user's general-runner select (labelled as applying to all projects) and the project GitHub token. The 502 for a pinned project carries `code: 'project-runner-offline'` with an actionable message.

## Risks / Trade-offs

- [Missing a data op in the scope check] → table-driven test enumerating every `data:*` type, failing when a new type lacks a project resolver.
- [Existing multi-runner users lose implicit fallback] → only applies to projects that opt into an override; default path (general) unchanged.
- [Cache staleness after revoke] → invalidate synchronously in the same request that changes assignments.

## Migration Plan

Additive migration `079_project_runner_binding` (SQLite + PG via the dialect-aware migration context): `runners.role`, `user_profiles.general_runner_id`, `project_runner_settings`, `project_runner_grants`. No backfill needed. Rollback: older code ignores the new columns/tables (but would restore the cross-project fallback).
