import type { GitStatusInfo } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import type { ProjectGitStatus } from './keys';
import { getGitStatusData } from './store';

/**
 * Make the given maps the session's git status (tests and stories), in the
 * shape of the former store fields. Maps left out keep their rows.
 */
export function seedGitStatus(
  {
    statusByBranch,
    threadToBranchKey,
    statusByProject,
  }: {
    statusByBranch?: Record<string, GitStatusInfo>;
    threadToBranchKey?: Record<string, string>;
    statusByProject?: Record<string, ProjectGitStatus>;
  },
  layer: DataLayer = getDataLayer(),
): void {
  const data = getGitStatusData(layer);
  if (statusByBranch) {
    data.statuses.replaceAll(Object.entries(statusByBranch).map(([id, s]) => ({ ...s, id })));
  }
  if (threadToBranchKey) {
    data.threadKeys.replaceAll(
      Object.entries(threadToBranchKey).map(([id, branchKey]) => ({ id, branchKey })),
    );
  }
  if (statusByProject) {
    data.projects.replaceAll(Object.entries(statusByProject).map(([id, s]) => ({ ...s, id })));
  }
}
