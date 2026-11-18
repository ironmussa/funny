import { request } from './_core';

// REST on purpose: the server proxies it to the user's runner, which owns the
// browser sessions.
export const browserSessionsApi = {
  /** The caller's threads that hold a live browser session on their runner. */
  liveThreads: () => request<{ threadIds: string[] }>('/browser-session/threads'),
};
