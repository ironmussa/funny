import { useProjectStore } from '@/stores/project-store';
import { useThreadProjectId } from '@/stores/thread-context';

/** Project the GitHub tabs query: the active thread's project, else the selected one. */
export function useGitHubProjectId(): string | null {
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const threadProjectId = useThreadProjectId();
  return threadProjectId ?? selectedProjectId;
}
