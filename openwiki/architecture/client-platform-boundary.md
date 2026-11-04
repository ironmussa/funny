# Client platform boundary

`@funny/client-core` contains renderer-independent client behavior. It compiles with only the
ES2023 library and must not import React renderers, browser/Tauri/Vite packages, DOM types, or
browser globals. `@funny/client` remains the React DOM/Tauri application and owns the concrete
platform adapter.

## Composition flow

```text
browser/Tauri environment
        │
        ▼
createWebPlatform ── validates ── ClientPlatform
        │                              │
        │                              ├─ storage
        │                              ├─ navigation
        │                              ├─ transport
        │                              ├─ lifecycle
        │                              ├─ semantic effects
        │                              └─ diagnostics
        ▼
compatibility hooks/stores, API clients, realtime controllers, then React
```

Factories receive only the capabilities they use. They do not import the application composition
singleton. Compatibility modules in `@funny/client` bind vanilla stores to React and retain legacy
exports while callers migrate incrementally.

## Server-backed entity state: the data layer

Server-backed entities no longer live in Zustand stores. They live in `packages/client/src/data/`
(openspec change `adopt-tanstack-db-client`), which is renderer-independent: only the `hooks.ts`
file of each entity folder imports React, and the folder never imports `@/stores`,
`@/components` or `sonner`.

- **One `DataLayer` per session** (`data/runtime.ts`, `data/data-layer.ts`). It owns every
  collection, a shared query-core `QueryClient` and an abort signal, and is replaced when the
  user or active organization changes. Entity modules attach their resources lazily.
- **Collections** (TanStack DB) for rows with per-row writes: threads, projects, agent
  templates, git status, automations and runs, comments, jobs, watchers, scheduler runs,
  pipeline approvals.
- **Queries** for request-shaped data: runner providers, sandbox connections, ACP models,
  template usage stats, project branch listings (`data/projects/branches.ts`), PR detail and
  review threads (`data/pull-requests/`). `staleTime` and in-flight de-duplication replace the
  former per-store cooldown and `loading` maps.
- **Writes**: user actions are optimistic transactions in `data/*/actions.ts`
  (`data/optimistic-write.ts` rolls back with a toast). Server responses and realtime events
  are synced writes through loaders and `apply*Event` functions. Thread writes are fenced per
  field (`data/threads/merge.ts`) so a response that started before a confirmed write cannot
  revert it.
- **Reads**: components use `data/*/hooks.ts` live queries; non-React code uses `data/*/read.ts`.
- **Resync**: `data/resync.ts` invalidates every query on reconnect and refetches those with a
  mounted reader.
- **Guardrail**: `scripts/fitness/check-client-data-layer.ts` (in `bun run lint`) rejects
  collection writes outside `src/data/**` (except the `stores/thread-row-writes.ts` shim) and
  the removed Zustand thread index (`threadsById`, bucket arrays) or its helpers.

The remaining stores hold UI state and the loaded thread payload (`threadDataById`: messages,
tool calls, events), which `stores/thread-mutations.ts` patches together with its
`activeThread` mirror.

## Store inventory

Classification is behavioral. “Portable” means the file is renderer-neutral or is a thin binding
over a core factory. “Mixed” means useful state is coupled transitively to the web API, app effects,
or another renderer store. “Web” means the state exists specifically to drive the DOM renderer.

| Classification    | Production files                                                                                                                                                                                                                                                                                                                                                   | Ownership note                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable          | `circuit-breaker-store.ts`, `thread-mutations.ts`, `thread-read-store.ts`, `thread-row-writes.ts`, `thread-select-helpers.ts`, `thread-selectors.ts`, `thread-state.ts`, `thread-store-internals.ts`, `thread-types.ts`, `thread-view.ts`                                                                                                                          | Core factories or pure state/types. The two compatibility stores are React bindings over `client-core`.                                                                                                                                                                                                                   |
| Mixed             | `app-store.ts`, `auth-store.ts`, `commit-progress-store.ts`, `native-git-store.ts`, `pipeline-store.ts`, `presence-store.ts`, `profile-store.ts`, `project-store.ts`, `runner-status-store.ts`, `settings-store.ts`, `store-bridge.ts`, `thread-history-store.ts`, `thread-machine-bridge.ts`, `thread-store.ts`, `thread-ws-handlers.ts`, `workflow-run-store.ts` | State or transformations may be reusable, but the module still imports web API singletons, browser persistence/effects, React transitions, or other mixed stores. `settings-store` delegates portable preferences to core and retains server/CSS concerns. `project-store` receives route snapshots through the platform. |
| Intentionally web | `branch-picker-store.ts`, `browser-panel-store.ts`, `draft-store.ts`, `internal-editor-store.ts`, `media-preview-store.ts`, `preview-store.ts`, `review-pane-store.ts`, `terminal-store.ts`, `test-store.ts`, `thread-context.tsx`, `ui-store.ts`                                                                                                                  | Renderer interaction, panels, DOM/editor/terminal state, React context, or browser-only local UI persistence.                                                                                                                                                                                                             |

When moving a mixed module, extract its stable state transitions or a narrow action port. Do not move
an entire Zustand store merely because some fields are reusable.

## Intentionally renderer-specific areas

These stay in `@funny/client` and a future renderer supplies native equivalents instead of DOM
shims:

- layout measurement and browser observers;
- selection, scroll, drag-and-drop, shortcuts, clipboard, and focus behavior;
- CSS variable/theme application (portable preference values live in core);
- Monaco and terminal rendering;
- browser panels, preview windows, and DOM custom-event delivery;
- React hooks, contexts, components, and router bindings.

## Adding portable behavior

Move logic to `client-core` only when it has a concrete non-renderer use and can be expressed through
an existing narrow capability or action port. Add a capability only when injection is necessary,
provide an in-memory implementation, add a no-DOM test, and retain web parity coverage. Run
`bun run fitness:layering:test` and `bun run fitness:layering` to verify the boundary.
