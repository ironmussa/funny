# Plan: Show current branch in sidebar for each project

## Goal
When a project is expanded in the sidebar, show the current git branch name (from the main repo) below the project name. This gives the user visibility into which branch each project is on without needing to open a thread.

## Implementation

### 1. Add branch state to `project-store.ts`
- Add a `branchByProject: Record<string, string>` state field
- Add a `fetchBranch(projectId: string)` action that calls `api.listBranches(projectId)` and stores the `currentBranch` value
- Call `fetchBranch` when a project is expanded

### 2. Show branch in `ProjectItem.tsx`
- Import `GitBranch` icon from lucide-react
- Import `useProjectStore` to read `branchByProject[project.id]`
- Display the branch name next to the project name (or below it) with the `GitBranch` icon, in a small muted style
- Only show when the branch is loaded (non-null)

### Files to modify
1. `packages/client/src/stores/project-store.ts` — add branch fetching state
2. `packages/client/src/components/sidebar/ProjectItem.tsx` — display the branch
