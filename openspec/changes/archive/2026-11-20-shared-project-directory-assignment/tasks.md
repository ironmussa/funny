## 1. Runtime — Path Resolution

- [x] 1.1 Add `getMemberLocalPath(projectId, userId)` query to `packages/runtime/src/services/project-manager.ts` — queries `project_members` table for the member's `localPath`
- [x] 1.2 Add `resolveProjectPath(projectId, userId): Result<string, DomainError>` to `packages/runtime/src/services/project-manager.ts` — returns `project.path` for owners, `localPath` for members, or error if not configured
- [x] 1.3 Replace all direct `project.path` usage in `packages/runtime/src/services/thread-service.ts` with the resolved path from `resolveProjectPath()` — covers `createAndStartThread()`, `sendMessage()`, `resumeThread()`, worktree creation, and branch checkout (~15 references)

## 2. Server — Validation & API

- [x] 2.1 Enhance `POST /:id/local-path` in `packages/server/src/routes/projects.ts` (or runtime equivalent) to validate the submitted path: must be absolute, must be a git repository (`isGitRepoSync`)
- [x] 2.2 Add upsert logic so `POST /:id/local-path` creates the `project_members` record if it doesn't exist (lazy creation), or updates `localPath` if it does
- [x] 2.3 Add validation guard in `packages/server/src/routes/threads.ts` — before creating a thread, if the project is a team project and the user is not the owner, verify the user has a `localPath` configured; return 400 if not

## 3. Project List API — Include localPath

- [x] 3.1 Modify the project listing endpoint (or the function that lists team projects) to augment each shared project with the current user's `localPath` and a `needsSetup` boolean flag
- [x] 3.2 Add `localPath?: string` and `needsSetup?: boolean` optional fields to the `Project` type in `packages/shared/src/types.ts`

## 4. Client — UI for Directory Setup

- [x] 4.1 Add `localPath` and `needsSetup` state to the project model in `packages/client/src/stores/app-store.ts`
- [x] 4.2 Create `SetupProjectDialog.tsx` in `packages/client/src/components/` — a dialog using shadcn `Dialog` component with a file browser (reusing the existing browse API) to select a local directory, and a save button that calls `POST /:id/local-path`
- [x] 4.3 Modify `ProjectItem.tsx` in `packages/client/src/components/sidebar/` to show a warning indicator on shared projects with `needsSetup === true`, and open the `SetupProjectDialog` when clicked
- [x] 4.4 Disable "New Thread" action on projects with `needsSetup === true` in the sidebar/project context

## 5. Verification

- [x] 5.1 Build the project (`bun run build`) and verify no type errors — client builds clean; runtime/server have pre-existing unrelated errors
