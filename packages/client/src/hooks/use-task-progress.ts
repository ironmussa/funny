import { parseTaskProgress, type TaskProgress } from '@funny/shared/task-progress';

import { useProgressFile, type ProgressFileState } from '@/hooks/use-progress-file';

const isRunning = (progress: TaskProgress) => progress.status === 'running';

/** Follows a task progress file (see `@funny/shared/task-progress`). */
export function useTaskProgress(path: string | null): ProgressFileState<TaskProgress> {
  return useProgressFile(path, parseTaskProgress, isRunning);
}
