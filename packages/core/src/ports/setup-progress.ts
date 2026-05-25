/**
 * Progress callback shape shared between worktree creation and port setup.
 * Lives in its own file so `worktree.ts` can depend on the type without
 * pulling in `ports/index.ts` (which itself depends on worktree.ts).
 */
export type SetupProgressFn = (
  step: string,
  label: string,
  status: 'running' | 'completed' | 'failed',
  error?: string,
) => void;
