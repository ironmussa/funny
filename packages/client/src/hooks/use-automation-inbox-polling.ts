import { useEffect } from 'react';

import { loadInbox } from '@/data/automations/loaders';
import { useAuthStore } from '@/stores/auth-store';

const BASE_POLL_MS = 60_000;
const MAX_POLL_MS = 300_000; // 5 min cap

/**
 * Polls the automation inbox while the user is signed in, so the tool rail's
 * inbox badge stays current. Mounted once, by the app shell: the rail itself
 * is unmounted under full-screen views such as settings.
 */
export function useAutomationInboxPolling() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  // The cleanup clears the current retry timeout, while cancelled prevents an in-flight poll reschedule.
  // react-doctor-disable-next-line effect-needs-cleanup
  useEffect(() => {
    if (!isAuthenticated) return;

    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const poll = async () => {
      const result = await loadInbox();
      failures = result.isOk() ? 0 : failures + 1; // reset on success
      if (cancelled) return;
      // Exponential backoff: 60s, 120s, 240s, capped at 5 min
      const delay = Math.min(BASE_POLL_MS * Math.pow(2, failures), MAX_POLL_MS);
      timer = setTimeout(poll, delay);
    };

    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isAuthenticated]);
}
