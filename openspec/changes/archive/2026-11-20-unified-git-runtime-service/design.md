## Context

Runtime Git behavior currently lives in several places:

- `packages/runtime/src/routes/git/status.ts` schedules background fetches, computes status, emits refs-updated hints, and manages bulk status cache.
- `packages/runtime/src/routes/git/remote.ts` performs explicit project/thread fetch, push, and pull handling with local cache invalidation.
- `packages/runtime/src/routes/projects/git-routes.ts` serves branch data and previously called low-level fetch directly.
- `packages/runtime/src/routes/git/helpers.ts` owns some shared helpers, but it is route-adjacent rather than a runtime service boundary.

This split makes it easy for route handlers to bypass common behavior. Git itself should still run as separate OS processes per operation, but runtime policy should be centralized so the app does not schedule duplicated remote work for the same repository.

## Goals / Non-Goals

**Goals:**

- Add a `GitRuntimeService` boundary in runtime service code.
- Centralize background fetch scheduling, explicit fetch execution, in-flight dedupe, cache invalidation, and refs-updated notification.
- Route project branches, project status, bulk status, thread status, and explicit fetch endpoints through the service.
- Keep public HTTP routes, payloads, and response shapes unchanged.
- Preserve per-repository/worktree concurrency where it is useful while preventing duplicate remote fetches for the same repository path.

**Non-Goals:**

- Do not replace `@funny/core/git`; it remains the low-level Git implementation.
- Do not create a single global Git process or serialize all Git operations across all repositories.
- Do not refactor every Git write operation in one pass.
- Do not change authentication, authorization, or database schema.

## Decisions

### Decision: Runtime service over route helper

Create `packages/runtime/src/services/git-runtime-service.ts` as the owner of runtime Git orchestration. Route helpers may remain temporarily for compatibility, but route handlers should call the service for coordinated operations.

Alternative considered: keep expanding `routes/git/helpers.ts`. Rejected because helpers under `routes/` encourage route-to-route coupling and make the orchestration layer harder to reuse from event handlers or future services.

### Decision: Deduplicate remote fetches by repository path

Remote fetch dedupe should key by canonical project path/worktree path passed to the service. If a fetch is already in flight for that path, background scheduling returns `false`; explicit fetch can either join or run through a serialized path depending on call type.

Alternative considered: dedupe by project id only. Rejected because thread/worktree operations may legitimately use different cwd values under the same project, while status background fetch should usually target the project root.

### Decision: Keep routes as API adapters

Routes continue to resolve request parameters, authorization context, and response formatting. The coordinator handles Git policy and returns typed results or booleans. This keeps the HTTP surface stable while shrinking route-owned Git policy.

Alternative considered: move entire handlers into service methods. Rejected for now because route handlers also own Hono-specific concerns and this would create a broad refactor with little immediate benefit.

### Decision: Incremental migration

The first implementation moves fetch coordination and branch/status fetch scheduling into the service. Follow-up tasks can migrate push/pull/stash/stage/cache behavior once the boundary is established and tested.

Alternative considered: one large extraction of all Git route logic. Rejected because Git routes cover many workflows, and a staged migration gives better test isolation.

## Risks / Trade-offs

- Fetch dedupe could suppress a fetch that a caller expected to force immediately -> explicit fetch endpoints should use an explicit method with clear semantics, separate from throttled background scheduling.
- Additional service indirection could obscure route behavior -> keep method names narrow and add focused tests for scheduler outcomes.
- Existing tests mock route helpers -> update tests to mock the service or preserve helper wrappers during the first migration.
- In-memory dedupe only works per runtime process -> acceptable for the local runner model; multi-runner/server coordination is out of scope for this change.

## Migration Plan

1. Add `GitRuntimeService` with background fetch scheduling and explicit fetch methods.
2. Delegate existing `scheduleBackgroundFetch` helper to the service to avoid a large call-site migration in one commit.
3. Update project branch route to call the service directly.
4. Update explicit project/thread fetch routes to call the service for fetch plus cache invalidation.
5. Add focused tests for dedupe and explicit fetch invalidation behavior.
6. Gradually migrate status routes from helper wrapper to service methods.

Rollback is straightforward: route call sites can be switched back to existing helpers because public API contracts are unchanged.

## Open Questions

- Should explicit fetch join an in-flight background fetch or wait for it to complete before returning? Initial implementation should preserve current explicit fetch behavior unless tests show user-visible duplication.
- Should later phases introduce separate read/write concurrency limits at the runtime service layer, or rely on `@funny/core/git/process.ts` pools?

## Follow-up Inventory

The first increment centralizes fetch coordination. Remaining route-owned Git policy that should move behind `GitRuntimeService` in later passes:

- Project write routes in `routes/git/remote.ts`: push, push-branch, pull, set remote, and publish still perform cache invalidation inline.
- Stage routes in `routes/git/stage.ts` repeatedly delete `_gitStatusCache` after mutations.
- Stash routes in `routes/git/stash.ts` delete project/thread caches inline.
- Commit routes in `routes/git/commit.ts` delete project/thread caches inline.
- Status aggregation in `routes/git/status.ts` still uses helper exports for cache reads/writes and background fetch scheduling; the helper now delegates scheduling to the service, but the route still owns aggregation cache access.
- Non-route services such as `git-service.ts`, `git-pipelines.ts`, and `pipeline-adapter.ts` still call cwd-keyed `invalidateStatusCache` directly for their own operations; those can move later if the coordinator becomes the single invalidation facade for all runtime Git writes.
