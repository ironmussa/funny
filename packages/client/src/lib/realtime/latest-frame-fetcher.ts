/**
 * Screencast frames arrive as references to fetch (one GET each). A playing
 * video repaints tens of times per second, and fetching every frame floods the
 * server with requests. Frames are latest-state, so per session at most one
 * fetch runs at a time and only the newest reference waits behind it: the
 * ones in between are skipped, never fetched.
 */
export function createLatestFrameFetcher(options: {
  fetch: (url: string) => Promise<string>;
  deliver: (sessionId: string, data: string) => void;
  onError: (error: unknown) => void;
}) {
  const sessions = new Map<string, { pending: string | null }>();

  const run = async (sessionId: string, url: string): Promise<void> => {
    try {
      options.deliver(sessionId, await options.fetch(url));
    } catch (error) {
      options.onError(error);
    }
    const state = sessions.get(sessionId);
    const next = state?.pending ?? null;
    if (!state || next === null) {
      sessions.delete(sessionId);
      return;
    }
    state.pending = null;
    return run(sessionId, next);
  };

  return {
    /** A frame reference arrived for a session. */
    push(sessionId: string, url: string): void {
      const state = sessions.get(sessionId);
      if (state) {
        state.pending = url; // replaces any older waiting frame
        return;
      }
      sessions.set(sessionId, { pending: null });
      void run(sessionId, url);
    },
  };
}
