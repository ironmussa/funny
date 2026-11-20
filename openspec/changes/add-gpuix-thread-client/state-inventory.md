# MVP State Behavior Inventory

This inventory fixes the portable vertical slice to existing Funny behavior. It is intentionally
limited to the native MVP; renderer layout, DOM measurement, terminal, browser panel, and settings
presentation remain in `@funny/client`.

| Concern           | MVP behavior                                                                                                                                  | Current canonical implementation                                       | Portable owner                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| Authentication    | Bootstrap a session, expose authenticated/rejected/anonymous states, retain active organization identity, and clear protected state on logout | `packages/client/src/stores/auth-store.ts` and Better Auth endpoints   | `createAuthSessionStore` plus the native auth service |
| Projects          | Preserve server order, accessible project metadata, selected project, and protected-resource cleanup                                          | `packages/client/src/stores/project-store.ts`                          | `createThreadNavigationStore`                         |
| Thread navigation | Preserve project buckets, scratch threads, shared-with-me threads, totals, and server identity                                                | `packages/client/src/stores/thread-store.ts` and `thread-mutations.ts` | `createThreadNavigationStore`                         |
| Selected thread   | Keep one selected identity and normalized messages/tool calls, pagination, run, and permission state                                          | `thread-state.ts`, `thread-types.ts`, and `thread-mutations.ts`        | `createThreadWorkspaceStore`                          |
| Pagination        | Initial windows replace canonical order; older pages prepend without duplicate IDs                                                            | `thread-store.ts` message loading                                      | workspace merge operations                            |
| Realtime          | Durable messages upsert; streaming revisions mutate a stable row; duplicate/late event IDs are inert                                          | `thread-ws-handlers.ts` and `ws-event-dispatch.ts`                     | workspace merge operations and shared dispatcher      |
| Prompt            | One in-flight submission per thread, optimistic row reconciliation, retryable failure                                                         | `thread-store.ts#sendMessage` and prompt hooks                         | `createThreadCommandController`                       |
| Run control       | Stop and waiting-response resume are single-flight and preserve received output                                                               | thread API and thread machine status events                            | command controller plus run state                     |
| Permission        | Key by thread, run, and request IDs; approve/deny once; stale or superseded requests are inert                                                | structured permission request API and `PendingPermissionRequest`       | workspace permission state and command controller     |

The web client remains behaviorally unchanged. Its route parser and ordered-ID de-duplication use
the same renderer-neutral helpers, which provide compatibility coverage without replacing its UI
store wholesale during this milestone.
