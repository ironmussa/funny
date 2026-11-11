import { parseTestProgress, type TestProgress } from '@funny/shared/test-progress';

import {
  PROGRESS_POLL_MS,
  useProgressFile,
  type ProgressFileState,
} from '@/hooks/use-progress-file';

/** How often a running test progress file is re-read. */
export const TEST_PROGRESS_POLL_MS = PROGRESS_POLL_MS;

export type TestProgressState = ProgressFileState<TestProgress>;

const isRunning = (progress: TestProgress) => progress.status === 'running';

/** Follows a test progress file (see `@funny/shared/test-progress`). */
export function useTestProgress(path: string | null): TestProgressState {
  return useProgressFile(path, parseTestProgress, isRunning);
}
