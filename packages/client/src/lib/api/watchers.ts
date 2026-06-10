import type { Watcher } from '@funny/shared';

import { request } from './_core';

export const watchersApi = {
  listWatchers: () => request<Watcher[]>('/watchers'),
  cancelWatcher: (id: string) => request<Watcher>(`/watchers/${id}/cancel`, { method: 'POST' }),
};
