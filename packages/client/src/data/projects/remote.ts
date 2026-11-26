import { gitApi } from '@/lib/api/git';

import { unwrapResult } from '../query-client';

/** A project's remote changes rarely (publishing the repo, editing the origin). */
const REMOTE_STALE_MS = 5 * 60_000;

/**
 * The project's origin remote (`GET /git/project/:id/remote-url`) as one
 * shared query per project: every issue chip of the project reads the same
 * entry, so they share one request.
 */
export function projectRemoteUrlQuery(projectId: string) {
  return {
    queryKey: ['project-remote-url', projectId] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<string | null> =>
      (await unwrapResult(gitApi.projectGetRemoteUrl(projectId, signal))).remoteUrl,
    staleTime: REMOTE_STALE_MS,
  };
}
