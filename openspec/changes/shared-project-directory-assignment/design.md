## Context

The app supports project sharing via `team_projects` (org-level visibility) and `project_members` (per-user membership). When User A shares a project, User B can see it in their sidebar with a "Team" badge. However, the system always uses `project.path` (the owner's filesystem path) when executing threads — which doesn't exist on User B's machine.

The `project_members` table already has a `localPath` column, the `setMemberLocalPath()` function exists in the server's project-manager, and the `POST /:id/local-path` route is wired up. But none of this is connected to the thread execution path or exposed in the UI.

Current path resolution in `thread-service.ts`:

- `createAndStartThread()` → uses `project.path` directly (~15+ references)
- `sendMessage()` → uses `thread.worktreePath ?? project.path`
- `resumeThread()` → uses `thread.worktreePath || project.path`
- Worktree creation → uses `project.path` as the base directory

## Goals / Non-Goals

**Goals:**

- Members of shared projects can assign their own local working directory
- Thread execution resolves the correct per-user path (owner uses `project.path`, member uses `localPath`)
- UI shows a clear "needs setup" state for shared projects without a configured directory
- Thread creation is blocked until the member configures their directory
- Local path validation ensures the directory is a valid git repo with an absolute path

**Non-Goals:**

- Auto-cloning the repository for the member (they must have a local clone already)
- Verifying that the member's clone is on the same branch or has the same commits
- Remote URL matching validation (too strict — forks, SSH vs HTTPS, etc. make this fragile)
- Changing the `team_projects` or `project_members` schema (both already sufficient)
- Multi-runner path resolution (this change is for the local runner only)

## Decisions

### 1. Introduce `resolveProjectPath(projectId, userId)` in runtime project-manager

**Decision:** Create a single function that encapsulates the path resolution logic.

**Rationale:** Currently `project.path` is used directly in ~15 places across `thread-service.ts`. A centralized resolver avoids scattering the owner-vs-member check everywhere. It returns a `Result<string, DomainError>` following the codebase's `neverthrow` convention.

**Logic:**

1. If `userId === project.userId` (owner) → return `project.path`
2. Else → query `project_members` for `localPath`
3. If no member record or `localPath` is null → return `err("Directory not configured")`

**Alternative considered:** Passing `localPath` through the thread creation params from the server. Rejected because it puts path resolution responsibility on the caller instead of centralizing it.

### 2. Lazy `project_members` creation (Hybrid model)

**Decision:** `team_projects` provides visibility; `project_members` records are created when the user assigns their directory (lazy activation).

**Rationale:**

- Avoids creating N member records when a project is shared with an org
- Handles new users joining the org naturally — they see the project via `team_projects` and activate via `project_members`
- Aligns with the existing code: `team_projects` is the join table for visibility, `project_members` carries per-user config

**Alternative considered:** Eagerly creating `project_members` for all org members when a project is shared. Rejected because it creates orphan records and doesn't handle new org members.

### 3. Skip remote URL validation

**Decision:** Only validate that the assigned path is an absolute path to a git repository. Do NOT verify that the remote origin matches.

**Rationale:** Remote URL comparison is fragile — SSH vs HTTPS, forks, mirrors, renamed repos, and multiple remotes all create false negatives. The user knows what they're doing when they pick a directory. The existing `createProject` validation (absolute path + git repo check) is the right level of strictness.

### 4. Project list API includes `localPath` for the current user

**Decision:** When listing projects (especially team projects), augment the response with the current user's `localPath` from `project_members`. Add `localPath?: string` and `needsSetup?: boolean` to the `Project` type.

**Rationale:** The client needs this information to render the "needs setup" state without making additional API calls per project. The server already knows the current user from the auth context.

### 5. UI uses existing browse endpoint for directory selection

**Decision:** The `SetupProjectDialog` reuses `GET /api/browse/list` for the file browser, same as the existing "Add Project" folder picker.

**Rationale:** No new infrastructure needed. The browse endpoint already handles filesystem navigation.

## Risks / Trade-offs

- **[Risk] Member points to wrong repository** → Mitigation: Accept this risk. The user is responsible for selecting the correct clone. Adding remote URL validation would create too many false negatives.
- **[Risk] Member's clone is stale or on wrong branch** → Mitigation: Out of scope. The worktree system already handles branch management. The member just needs a valid git repo root.
- **[Risk] Path resolution adds a DB query to every thread operation** → Mitigation: The query is a simple PK lookup on `project_members(projectId, userId)`. Negligible latency.
- **[Trade-off] `project.path` references in thread-service.ts are numerous (~15+)** → Mitigated by introducing `resolveProjectPath()` and replacing all direct `project.path` usage with the resolved path. This is a significant but mechanical change.
