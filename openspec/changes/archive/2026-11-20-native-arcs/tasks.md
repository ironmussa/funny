## 1. Shared Types & Schema

- [x] 1.1 Add `Arc` interface to `packages/shared/src/types.ts` with fields: `id`, `projectId`, `userId`, `name`, `createdAt`, `threadCount` (optional, for list queries)
- [x] 1.2 Add `ThreadPurpose` type (`'explore' | 'implement'`) and add `arcId?: string` and `purpose: ThreadPurpose` fields to the `Thread` interface
- [x] 1.3 Add API request/response types: `CreateArcRequest`, `ArcWithArtifacts`, `ArcArtifacts` (proposal, design, tasks, specs contents)
- [x] 1.4 Add `arcs` table to both `schema.sqlite.ts` and `schema-pg.ts` with columns: `id`, `projectId`, `userId`, `name`, `createdAt`
- [x] 1.5 Add `arcId` (nullable FK) and `purpose` (text, default `'implement'`) columns to the `threads` table in both schema files
- [x] 1.6 Add migration SQL to `db/migrate.ts` for the new `arcs` table and new `threads` columns

## 2. Arc Artifact Management (Core)

- [x] 2.1 Create `packages/runtime/src/services/arc-service.ts` with functions: `createArcDirectory(projectPath, name)`, `readArcArtifacts(projectPath, name)`, `validateArcName(name)`
- [x] 2.2 Implement `createArcDirectory` — creates `arcs/<name>/` directory (and parent `arcs/` lazily) at the resolved project path
- [x] 2.3 Implement `readArcArtifacts` — reads proposal.md, design.md, tasks.md, and globs `specs/*/spec.md` from `arcs/<name>/`, returning content for each file that exists
- [x] 2.4 Implement `validateArcName` — kebab-case validation (lowercase, numbers, hyphens, no leading/trailing hyphen, max 100 chars)

## 3. Arc Agent Prompts

- [x] 3.1 Create `packages/runtime/src/services/arc-prompts.ts` with the explore and implement system prompt strings, extracted and adapted from OpenSpec skill prompts
- [x] 3.2 Implement `getExplorePrompt(arcName)` — returns the explore system prompt with arc name and artifact paths interpolated
- [x] 3.3 Implement `getImplementPrompt(arcName)` — returns the implement system prompt referencing the arc's artifacts

## 4. Agent Runner Integration

- [x] 4.1 In `agent-runner.ts`, after resolving project system prompt and before memory context, add arc context injection: read arc artifacts and purpose prompt when the thread has an `arcId`
- [x] 4.2 Assemble arc context as labeled sections (`[ARC CONTEXT]` / `[ARC PURPOSE]`) in the systemPrefix array between project instructions and memory

## 5. Thread Service Integration

- [x] 5.1 Update `CreateAndStartThreadParams` and `CreateIdleThreadParams` to accept optional `arcId` and `purpose` fields
- [x] 5.2 Pass `arcId` and `purpose` through to the thread DB insert in both `createAndStartThread()` and `createIdleThread()`
- [x] 5.3 Update thread creation validation schema (`createThreadSchema`) to accept optional `arcId` (string) and `purpose` (enum)

## 6. API Routes

- [x] 6.1 Create `packages/runtime/src/routes/arcs.ts` with route group mounted at `/api/projects/:id/arcs` and `/api/arcs/:id`
- [x] 6.2 Implement `GET /api/projects/:id/arcs` — list arcs for project with thread count
- [x] 6.3 Implement `POST /api/projects/:id/arcs` — create arc (DB record + filesystem directory)
- [x] 6.4 Implement `GET /api/arcs/:id` — get arc details with artifact contents
- [x] 6.5 Implement `GET /api/arcs/:id/threads` — list threads linked to an arc
- [x] 6.6 Implement `DELETE /api/arcs/:id` — delete arc record, set linked threads' arcId to null
- [x] 6.7 Mount arc routes in the runtime app (`packages/runtime/src/app.ts`)

## 7. Client: API & Store

- [x] 7.1 Add arc API methods to the client API module: `listArcs(projectId)`, `createArc(projectId, name)`, `getArc(arcId)`, `deleteArc(arcId)`
- [x] 7.2 Add arc state to the Zustand store: `arcs` array, `fetchArcs(projectId)`, `createArc(projectId, name)` actions

## 8. Client: NewThreadDialog

- [x] 8.1 Add purpose selector (shadcn Select) with options "Implement" and "Explore", `data-testid="new-thread-purpose"`
- [x] 8.2 Add arc picker (shadcn Select) listing project arcs + "+ New arc" option, `data-testid="new-thread-arc"`
- [x] 8.3 When purpose is "Explore": hide worktree toggle, force local mode, show arc picker
- [x] 8.4 When "+ New arc" is selected: show name input for new arc creation, validate kebab-case
- [x] 8.5 Pass `arcId` and `purpose` in the `api.createThread()` call

## 9. Client: Thread List

- [x] 9.1 Display arc name badge on thread list items when thread has `arcId`, `data-testid="thread-arc-badge"`
- [x] 9.2 Add visual indicator for explore vs implement purpose on thread items

## 10. Testing & Validation

- [x] 10.1 Verify the full flow: create arc → create explore thread → agent gets explore prompt → create implement thread → agent gets artifact context
- [x] 10.2 Verify backward compatibility: threads created without arc fields behave identically to current behavior
- [x] 10.3 Add `data-testid` attributes to all new interactive elements
