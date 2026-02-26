# Plan: Git Operation Progress Modal

## Goal

When the user performs git actions from the ReviewPane (commit, push, create PR, merge, etc.), show a modal dialog with step-by-step progress instead of just a spinner on the button and toast notifications.

## Approach

### 1. Create a `GitProgressModal` component

**File:** `packages/client/src/components/GitProgressModal.tsx`

A shadcn Dialog that shows a list of steps with their statuses (pending, running, completed, failed). Each step shows:

- An icon (spinner for running, checkmark for completed, X for failed)
- Step label (e.g., "Staging files", "Running commit", "Pushing to origin", "Creating PR")
- Optional output/error text for the completed/failed step

### 2. Create a `useGitProgress` hook or inline state

**Approach:** Add state management for the progress steps directly in ReviewPane, since all the git operations are already orchestrated there in `handleCommitAction`, `handlePushOnly`, `handleMergeOnly`, `handleCreatePROnly`.

Define a type:

```ts
interface GitProgressStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  output?: string;
}
```

And state:

```ts
const [progressSteps, setProgressSteps] = useState<GitProgressStep[]>([]);
const [progressOpen, setProgressOpen] = useState(false);
```

### 3. Refactor `handleCommitAction` and other handlers

Instead of just setting `actionInProgress` and calling API methods sequentially, we:

1. Build the step list based on the selected action
2. Open the modal
3. Execute each step, updating the step status as we go
4. On completion or failure, keep the modal open with final status
5. User dismisses the modal manually

**Step lists by action:**

- **commit**: Unstage unchecked → Stage checked → Commit
- **amend**: Unstage unchecked → Stage checked → Amend commit
- **commit-push**: Unstage unchecked → Stage checked → Commit → Push
- **commit-pr**: Unstage unchecked → Stage checked → Commit → Push → Create PR
- **commit-merge**: Unstage unchecked → Stage checked → Commit → Merge & Cleanup
- **push only**: Push to origin
- **merge only**: Merge into base branch
- **create PR only**: Push (if needed) → Create PR

### 4. Add i18n keys

Add new translation keys for step labels under `review.progress.*`:

- `review.progress.staging` / `review.progress.staged`
- `review.progress.unstaging` / `review.progress.unstaged`
- `review.progress.committing` / `review.progress.committed`
- `review.progress.pushing` / `review.progress.pushed`
- `review.progress.creatingPR` / `review.progress.prCreated`
- `review.progress.merging` / `review.progress.merged`
- `review.progress.amending` / `review.progress.amended`

### 5. Files to modify

1. **`packages/client/src/components/GitProgressModal.tsx`** — New component (small, ~80 lines)
2. **`packages/client/src/components/ReviewPane.tsx`** — Add progress state, refactor handlers, render modal
3. **`packages/client/src/locales/en/translation.json`** — Add progress step translations
4. **`packages/client/src/locales/es/translation.json`** — Add Spanish translations
5. **`packages/client/src/locales/pt/translation.json`** — Add Portuguese translations

### Design

- The modal uses shadcn `Dialog` component
- Steps displayed as a vertical list with status icons
- Spinner (`Loader2`) for running steps
- Check icon for completed steps
- X icon for failed steps
- Circle icon for pending steps
- On success: shows all green checkmarks, button says "Done"
- On failure: shows error message on the failed step, button says "Close"
- Remove toast notifications for operations that now show in the modal (keep the modal as the single feedback mechanism)
