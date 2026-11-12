import type { JobLogChunk } from '@funny/shared';

import { request } from './_core';
import { trpc, trpcCall } from './_trpc';

export const jobsApi = {
  listJobs: () => trpcCall(() => trpc.jobs.list.query()),
  // Cancel and log reads stay REST: the server proxies them to the runner that
  // owns the process and its logfile.
  cancelJob: (id: string) => request<{ ok: boolean }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  readLog: (id: string, offset = 0) =>
    request<JobLogChunk>(`/jobs/${id}/log?offset=${encodeURIComponent(String(offset))}`),
};
