import type { Job } from '@funny/shared';

import { request } from './_core';

export const jobsApi = {
  listJobs: () => request<Job[]>('/jobs'),
  cancelJob: (id: string) => request<{ ok: boolean }>(`/jobs/${id}/cancel`, { method: 'POST' }),
};
