import type { Job, JobLogChunk } from '@funny/shared';

import { request } from './_core';

export const jobsApi = {
  listJobs: () => request<Job[]>('/jobs'),
  cancelJob: (id: string) => request<{ ok: boolean }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  readLog: (id: string, offset = 0) =>
    request<JobLogChunk>(`/jobs/${id}/log?offset=${encodeURIComponent(String(offset))}`),
};
