import type { Job } from '@funny/shared';
import { create } from 'zustand';

import { jobsApi } from '@/lib/api/jobs';
import { createClientLogger } from '@/lib/client-logger';
import { useAuthStore } from '@/stores/auth-store';

const log = createClientLogger('job-store');

interface JobState {
  /** Every job the user owns, keyed by id (cross-thread). */
  jobsById: Record<string, Job>;

  loadJobs: () => Promise<void>;
  cancelJob: (id: string) => Promise<void>;

  /** WS handler — applied for every job:* event (created/exited/killed/cancelled). */
  upsert: (job: Job) => void;
}

export const useJobStore = create<JobState>((set, get) => ({
  jobsById: {},

  loadJobs: async () => {
    if (!useAuthStore.getState().isAuthenticated) return;
    const result = await jobsApi.listJobs();
    result.match(
      (jobs) => set({ jobsById: Object.fromEntries(jobs.map((j) => [j.id, j])) }),
      (error) => log.warn('Failed to load jobs', { error: error.message }),
    );
  },

  cancelJob: async (id) => {
    const prev = get().jobsById[id];
    if (prev) {
      set((s) => ({ jobsById: { ...s.jobsById, [id]: { ...prev, status: 'cancelled' } } }));
    }
    const result = await jobsApi.cancelJob(id);
    result.match(
      () => {}, // the runner emits job:cancelled with the authoritative row
      (error) => {
        log.warn('Failed to cancel job', { error: error.message });
        if (prev) set((s) => ({ jobsById: { ...s.jobsById, [id]: prev } })); // rollback
      },
    );
  },

  upsert: (job) => set((s) => ({ jobsById: { ...s.jobsById, [job.id]: job } })),
}));
