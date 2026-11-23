import { useRightPaneProjectId, useRightPaneThreadId } from '@/hooks/use-right-pane-target';
import { useThreadById } from '@/lib/thread-selectors';
import { canLoadGitHistory } from '@/lib/thread-variant';
import {
  useThreadProjectId,
  useThreadSelector,
  useThreadViewSelect,
} from '@/stores/thread-context';

/**
 * Whose history the graph shows: the right pane's thread, or (with no thread)
 * its project, and whether that target has a git history to load at all.
 */
export function useGraphGitContext() {
  const selectedProjectId = useRightPaneProjectId();
  const effectiveThreadId = useRightPaneThreadId() || undefined;
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;
  const threadProjectId = useThreadProjectId();
  const lightThread = useThreadById(effectiveThreadId);
  const threadIsScratch = useThreadSelector((t) => t?.isScratch);
  const threadBranchField = useThreadViewSelect(effectiveThreadId, (t) => t?.branch ?? null);
  const gitThread = effectiveThreadId
    ? {
        projectId: threadProjectId ?? lightThread?.projectId ?? '',
        isScratch: threadIsScratch ?? lightThread?.isScratch,
      }
    : null;
  const hasGitContext = !!projectModeId || canLoadGitHistory(gitThread);

  return { effectiveThreadId, projectModeId, gitThread, threadBranchField, hasGitContext };
}
