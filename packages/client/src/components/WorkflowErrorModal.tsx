import { GitProgressModal } from '@/components/GitProgressModal';
import { useCommitProgressStore } from '@/stores/commit-progress-store';

/**
 * Global modal that surfaces full error details when a git workflow
 * (push, commit-push, etc.) fails. Replaces the old generic toast.
 */
export function WorkflowErrorModal() {
  const failedWorkflow = useCommitProgressStore((s) => s.failedWorkflow);
  const clearFailedWorkflow = useCommitProgressStore((s) => s.clearFailedWorkflow);

  if (!failedWorkflow) return null;

  return (
    <GitProgressModal
      open
      onOpenChange={(open) => {
        if (!open) clearFailedWorkflow();
      }}
      title={failedWorkflow.title}
      steps={failedWorkflow.steps}
    />
  );
}
