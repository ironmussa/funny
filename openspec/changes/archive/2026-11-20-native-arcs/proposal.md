## Why

Funny threads have no concept of structured planning. Users create threads that run agents, but there's no way to explore an idea, capture decisions, and then spawn implementation threads that share that context. The OpenSpec CLI provides this workflow externally, but it's a separate tool with its own state — disconnected from Funny's thread lifecycle. We need a native, first-class concept that links thinking to implementation without external dependencies.

## What Changes

- Introduce **arcs** as a new first-class concept — a unit of planned work that progresses from exploration through implementation to completion
- Add an `arcs` database table (`id`, `projectId`, `userId`, `name`, `createdAt`) with no status field — status is derived from linked threads and filesystem artifacts
- Add `arcId` (FK) and `purpose` (`'explore'` | `'implement'`) fields to the `threads` table
- Store arc artifacts in the repository at `arcs/<name>/` (`proposal.md`, `design.md`, `tasks.md`, `specs/`)
- Extract and adapt agent prompts from OpenSpec skill definitions (explore, propose, implement) — no `openspec` CLI dependency
- Inject arc artifact content into agent `systemPrefix` when a thread is linked to an arc
- Add arc picker and purpose selector to `NewThreadDialog`
- Add API routes for arc CRUD and listing
- Many threads can link to one arc (N threads → 1 arc)

## Capabilities

### New Capabilities

- `arc-data-model`: Database schema for arcs table, thread FK, and purpose field. Arc CRUD operations and query helpers.
- `arc-agent-prompts`: Extracted system prompts for explore and implement thread purposes. Context injection of arc artifacts into agent systemPrefix.
- `arc-api`: REST API routes for listing, creating, reading arcs and their artifacts. Listing threads linked to an arc.
- `arc-thread-ui`: NewThreadDialog changes — purpose selector, arc picker dropdown, conditional field visibility based on purpose.
- `arc-artifact-management`: Filesystem operations for creating arc directories and reading artifact files from the repository.

### Modified Capabilities

_(none — no existing specs are changing at the requirement level)_

## Impact

- **Database**: New `arcs` table. Two new columns on `threads` table (`arcId`, `purpose`). Migration required.
- **Shared types**: New `Arc` interface, updated `Thread` interface, new API request/response types, new WebSocket events.
- **Runtime services**: `thread-service.ts` gains arc-aware creation params. `agent-runner.ts` gains arc context injection in systemPrefix assembly.
- **Runtime routes**: New `/api/projects/:id/arcs` and `/api/arcs/:id` route groups. Modified thread creation schema validation.
- **Client**: `NewThreadDialog.tsx` gains purpose selector and arc picker. `app-store.ts` gains arc state. New API client methods.
- **Filesystem**: `arcs/` directory created at project root for artifact storage.
