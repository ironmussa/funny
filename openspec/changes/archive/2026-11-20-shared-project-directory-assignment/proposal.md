## Why

When a project is shared with another user via `team_projects`, the member can see the project in their sidebar but cannot work on it. The project's `path` points to the owner's local filesystem (e.g., `/home/userA/my-app`), which doesn't exist on the member's machine. Members need a way to assign their own local directory (a clone of the same repo) before they can create threads and run agents.

## What Changes

- **Runtime path resolution**: When starting a thread or sending a message, the system will resolve the working directory per-user instead of always using `project.path`. Owners keep using `project.path`; members use their `project_members.localPath`.
- **Thread creation guard**: Creating threads on a shared project will be blocked if the member hasn't configured their local directory yet.
- **UI: Setup flow for shared projects**: Shared projects without a configured directory will show a warning state in the sidebar. Clicking opens a dialog where the member selects their local clone of the repo.
- **Local path validation**: When a member assigns their directory, the system validates it's an absolute path to a valid git repository.

## Capabilities

### New Capabilities

- `member-path-resolution`: Per-user working directory resolution for shared projects — determines the correct filesystem path based on whether the user is the project owner or a member.
- `member-directory-setup`: UI flow and API validation for members to assign and configure their local working directory on shared projects.

### Modified Capabilities

<!-- No existing specs to modify -->

## Impact

- **Runtime**: `project-manager.ts` (new `resolveProjectPath` function), `thread-service.ts` (use resolved path instead of `project.path` at 3 points)
- **Server routes**: `threads.ts` (validation guard), `projects.ts` (local-path endpoint enhancement)
- **Client**: `ProjectItem.tsx` (needs-setup state), new `SetupProjectDialog.tsx`, `app-store.ts` (localPath state), types
- **Database**: No schema changes — `project_members.localPath` already exists
- **API**: `POST /:id/local-path` already exists but needs validation enhancement; project list API needs to include `localPath` for the current user
