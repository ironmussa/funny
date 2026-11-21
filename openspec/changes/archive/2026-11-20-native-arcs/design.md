## Context

Funny threads run agents against a project but have no structured planning layer. The OpenSpec CLI provides explore → propose → apply workflows via Claude Code skills, but these are external and disconnected from Funny's thread model. The goal is to absorb this workflow natively.

Key existing infrastructure:

- **Thread model** already has `stage` (backlog → planning → in_progress → review → done), `status`, and `mode` (local / worktree)
- **Agent runner** assembles `systemPrefix` from project system prompt + Paisley Park memory + resume prefix — extensible via array concatenation
- **Thread service** handles creation with worktree setup, branch management, and agent spawning
- **NewThreadDialog** has provider/model/branch/worktree selectors — adding more fields follows the existing pattern
- **Database** uses Drizzle ORM with dual SQLite/PostgreSQL schemas and auto-migration via `db/migrate.ts`

## Goals / Non-Goals

**Goals:**

- Introduce `arcs` as a lightweight planning concept linking threads to shared context
- Allow explore threads (thinking partner, no code) and implement threads (read specs, work through tasks) against the same arc
- Store arc artifacts in the repository (`arcs/<name>/`) so they're version controlled and PR-visible
- Track arcs in the database for querying and UI rendering
- Inject arc artifact content into agent systemPrefix so agents start with full context
- Keep arc status derived (no stored status field) — computed from threads + artifact existence

**Non-Goals:**

- Building an `openspec` CLI replacement — we extract prompts, not rebuild the tool
- Artifact templating engine — agents write markdown files directly, no scaffolding commands
- Per-task thread assignment — threads link to the arc, not to individual tasks within it
- Arc status workflow enforcement — no state machine, no required transitions
- Cross-project arcs — an arc belongs to one project

## Decisions

### 1. Arc status is derived, not stored

**Decision:** The `arcs` table has no `status` column. Status is computed from linked threads and filesystem artifacts.

**Rationale:** Storing status creates a sync problem — what updates it? Thread completion? Artifact creation? A background job? Deriving it is simpler and always accurate.

**Derivation logic:**

- Has running threads → `active`
- Has `tasks.md` with all items checked → `done`
- Has `proposal.md` → `proposed`
- Has only explore threads → `exploring`
- Fallback → `new`

**Alternative considered:** Explicit status enum on arcs table. Rejected because it requires trigger logic to keep in sync with thread lifecycle events.

### 2. Thread gains `purpose` and `arcId` fields

**Decision:** Add `purpose` (text, default `'implement'`) and `arcId` (nullable FK to arcs) to the threads table.

**Rationale:** `purpose` is orthogonal to `mode` — you can explore in local mode or implement in worktree mode. `arcId` is nullable because most threads won't be linked to an arc (backward compatible).

**Alternative considered:** Overloading `stage` to encode purpose. Rejected because stage represents progress (planning → in_progress → done), not intent.

### 3. Artifacts live in `arcs/<name>/` at the repo root

**Decision:** Arc artifacts are markdown files in the project repository, not in the database or `~/.funny/`.

**Rationale:** Version controlled, visible in PRs, reviewable by humans, accessible to agents via filesystem tools. The database `arcs` table stores metadata (id, name, projectId) while the filesystem stores content.

**Directory structure:**

```
arcs/<name>/
  ├── proposal.md
  ├── design.md
  ├── tasks.md
  └── specs/
      ├── <capability>/spec.md
      └── ...
```

**Alternative considered:** Storing artifact content in database BLOB/TEXT columns. Rejected because it loses git history, PR visibility, and makes agent access harder.

### 4. Agent prompts are embedded in the runtime, not loaded from skill files

**Decision:** The explore and implement system prompts are hardcoded strings in the runtime (e.g., `arc-prompts.ts`), extracted and adapted from OpenSpec's SKILL.md files.

**Rationale:** No external dependency. The prompts are stable text that rarely changes. Keeping them in the runtime means they're deployed with the app and testable.

**Alternative considered:** Reading SKILL.md files from the filesystem at runtime. Rejected because it couples to OpenSpec's directory structure and adds a filesystem dependency.

### 5. Context injection via systemPrefix extension

**Decision:** When a thread has an `arcId`, the agent runner reads the arc's artifacts from the filesystem and prepends them to the `systemPrefix` array (after project system prompt, before memory context).

**Assembly order:**

```
systemPrefix = [
  projectSystemPrompt,    // existing
  arcContext,             // NEW — proposal + design + tasks + specs content
  arcPurposePrompt,       // NEW — explore or implement behavior instructions
  memoryContext,          // existing (Paisley Park)
  resumePrefix,           // existing
]
```

**Rationale:** Follows the existing pattern. Arc context is injected the same way project instructions and memory are — as prefixed system text.

### 6. Explore threads use local mode by default

**Decision:** When purpose is `explore`, the UI defaults to local mode with the worktree toggle hidden. Explore threads read the codebase and write to `arcs/` — they don't need an isolated worktree.

**Rationale:** Explore agents don't write application code. Their file writes go to `arcs/<name>/` which should be on the main branch so artifacts are immediately available to other threads.

**Alternative considered:** Allowing worktree for explore. Not blocked — just not the default. User can override if they want to explore on a branch.

## Risks / Trade-offs

**Large context window consumption** → Arc artifacts (proposal + design + tasks + specs) can be substantial. If an arc has 5 spec files, that's a lot of systemPrefix text. Mitigation: summarize specs instead of injecting full content, or let the agent read them on demand.

**Artifact format drift** → Without the OpenSpec CLI enforcing structure, agents may write inconsistent artifacts. Mitigation: the explore/propose prompts include format guidance, and artifacts are human-reviewable markdown.

**Filesystem assumptions** → Reading `arcs/` from the project path assumes the directory exists and is readable. For remote runners or containerized environments, the path may differ. Mitigation: use the resolved project path (already handled by `resolveProjectPath`) and create the directory lazily.

**Backward compatibility** → Adding `purpose` and `arcId` to threads must not break existing threads. Mitigation: `purpose` defaults to `'implement'`, `arcId` defaults to null. Existing threads behave identically.
