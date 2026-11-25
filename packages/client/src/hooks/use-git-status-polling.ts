import { useEffect } from 'react';

import { refreshScopedProjects } from '@/data/git-status/actions';
import { setVisibleInterval } from '@/lib/visible-interval';

/** How often the shown projects' git status (and their PR badges) is asked again. */
const GIT_STATUS_POLL_MS = 3 * 60_000;

/**
 * Re-ask the git status of the projects on screen every few minutes while the
 * tab is visible, and at once when it becomes visible again. A pull request
 * merged or closed on GitHub sends funny no event, so without this a thread
 * kept its PR badge "open" until something else refreshed its project.
 */
export function useGitStatusPolling(): void {
  useEffect(() => setVisibleInterval(() => refreshScopedProjects(), GIT_STATUS_POLL_MS), []);
}
