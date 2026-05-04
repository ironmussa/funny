import type { PRDetail, PRReviewThread } from '@funny/shared';
import { create } from 'zustand';

import { githubApi as api } from '@/lib/api/github';

const COOLDOWN_MS = 30_000;

function prKey(projectId: string, prNumber: number): string {
  return `${projectId}:${prNumber}`;
}

interface PRDetailState {
  /** PR detail keyed by `{projectId}:{prNumber}` */
  detailByKey: Record<string, PRDetail>;
  /** Review threads keyed by `{projectId}:{prNumber}` */
  threadsByKey: Record<string, PRReviewThread[]>;
  /** Loading flags */
  loadingDetail: Set<string>;
  loadingThreads: Set<string>;
  /** Last fetch timestamps for cooldown */
  lastFetchDetail: Record<string, number>;
  lastFetchThreads: Record<string, number>;
  /** Rate limit hit — stops auto-polling */
  rateLimited: boolean;

  fetchPRDetail: (projectId: string, prNumber: number, force?: boolean) => Promise<void>;
  fetchPRThreads: (projectId: string, prNumber: number, force?: boolean) => Promise<void>;
  /** Clear cooldowns so next fetch runs immediately */
  invalidate: (projectId: string, prNumber: number) => void;
  clearAll: () => void;
}

export const usePRDetailStore = create<PRDetailState>((set, get) => ({
  detailByKey: {},
  threadsByKey: {},
  loadingDetail: new Set(),
  loadingThreads: new Set(),
  lastFetchDetail: {},
  lastFetchThreads: {},
  rateLimited: false,

  fetchPRDetail: async (projectId, prNumber, force) => {
    const key = prKey(projectId, prNumber);
    const state = get();

    // Skip if already loading
    if (state.loadingDetail.has(key)) return;

    // Skip if within cooldown (unless forced)
    if (!force) {
      const last = state.lastFetchDetail[key] ?? 0;
      if (Date.now() - last < COOLDOWN_MS) return;
    }

    // Skip if rate limited (unless forced)
    if (state.rateLimited && !force) return;

    set((s) => ({ loadingDetail: new Set(s.loadingDetail).add(key) }));

    try {
      const result = await api.githubPRDetail(projectId, prNumber);
      if (result.isOk()) {
        set((s) => {
          const next = new Set(s.loadingDetail);
          next.delete(key);
          return {
            detailByKey: { ...s.detailByKey, [key]: result.value },
            loadingDetail: next,
            lastFetchDetail: { ...s.lastFetchDetail, [key]: Date.now() },
            rateLimited: false,
          };
        });
      } else {
        const errMsg = result.error?.message ?? '';
        const isRateLimit = errMsg.includes('403') || errMsg.includes('429');
        set((s) => {
          const next = new Set(s.loadingDetail);
          next.delete(key);
          return {
            loadingDetail: next,
            rateLimited: isRateLimit ? true : s.rateLimited,
          };
        });
      }
    } catch {
      set((s) => {
        const next = new Set(s.loadingDetail);
        next.delete(key);
        return { loadingDetail: next };
      });
    }
  },

  fetchPRThreads: async (projectId, prNumber, force) => {
    const key = prKey(projectId, prNumber);
    const state = get();

    if (state.loadingThreads.has(key)) return;
    if (!force) {
      const last = state.lastFetchThreads[key] ?? 0;
      if (Date.now() - last < COOLDOWN_MS) return;
    }
    if (state.rateLimited && !force) return;

    set((s) => ({ loadingThreads: new Set(s.loadingThreads).add(key) }));

    try {
      const result = await api.githubPRThreads(projectId, prNumber);
      if (result.isOk()) {
        set((s) => {
          const next = new Set(s.loadingThreads);
          next.delete(key);
          return {
            threadsByKey: { ...s.threadsByKey, [key]: result.value.threads },
            loadingThreads: next,
            lastFetchThreads: { ...s.lastFetchThreads, [key]: Date.now() },
            rateLimited: false,
          };
        });
      } else {
        const errMsg = result.error?.message ?? '';
        const isRateLimit = errMsg.includes('403') || errMsg.includes('429');
        set((s) => {
          const next = new Set(s.loadingThreads);
          next.delete(key);
          return {
            loadingThreads: next,
            rateLimited: isRateLimit ? true : s.rateLimited,
          };
        });
      }
    } catch {
      set((s) => {
        const next = new Set(s.loadingThreads);
        next.delete(key);
        return { loadingThreads: next };
      });
    }
  },

  invalidate: (projectId, prNumber) => {
    const key = prKey(projectId, prNumber);
    set((s) => ({
      lastFetchDetail: { ...s.lastFetchDetail, [key]: 0 },
      lastFetchThreads: { ...s.lastFetchThreads, [key]: 0 },
    }));
  },

  clearAll: () =>
    set({
      detailByKey: {},
      threadsByKey: {},
      loadingDetail: new Set(),
      loadingThreads: new Set(),
      lastFetchDetail: {},
      lastFetchThreads: {},
      rateLimited: false,
    }),
}));

/** Convenience selector hook */
export function usePRDetail(projectId: string | undefined, prNumber: number | undefined) {
  const key = projectId && prNumber ? prKey(projectId, prNumber) : '';
  const detail = usePRDetailStore((s) => (key ? s.detailByKey[key] : undefined));
  const threads = usePRDetailStore((s) => (key ? s.threadsByKey[key] : undefined));
  const loadingDetail = usePRDetailStore((s) => (key ? s.loadingDetail.has(key) : false));
  const loadingThreads = usePRDetailStore((s) => (key ? s.loadingThreads.has(key) : false));
  const rateLimited = usePRDetailStore((s) => s.rateLimited);
  return { detail, threads, loadingDetail, loadingThreads, rateLimited };
}
