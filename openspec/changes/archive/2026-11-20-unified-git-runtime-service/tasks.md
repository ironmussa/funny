## 1. Service Boundary

- [x] 1.1 Add `packages/runtime/src/services/git-runtime-service.ts` with coordinated background fetch scheduling.
- [x] 1.2 Move fetch in-flight dedupe and throttle state behind the service boundary.
- [x] 1.3 Add explicit project/thread fetch helpers that perform fetch plus cache invalidation.

## 2. Route Migration

- [x] 2.1 Delegate existing `scheduleBackgroundFetch` route helper to the service.
- [x] 2.2 Update project branches route to call the service directly.
- [x] 2.3 Update explicit project and thread fetch routes to call the service.

## 3. Verification

- [x] 3.1 Add or update tests for background fetch dedupe behavior.
- [x] 3.2 Add or update tests for explicit fetch route behavior and cache invalidation.
- [x] 3.3 Run focused runtime route/service tests and static checks for touched files.

## 4. Follow-up Migration

- [x] 4.1 Identify remaining direct route-owned Git policy that should move behind `GitRuntimeService`.
- [x] 4.2 Leave follow-up notes for migrating push, pull, status aggregation, and write-operation cache invalidation.
