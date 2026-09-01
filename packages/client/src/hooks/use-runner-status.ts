/**
 * Tracks whether the current user has at least one runner registered.
 *
 * Per-user by construction (the API is scoped to the caller's runners), so it
 * powers the "connect a runner" onboarding for everyone — including non-admin
 * collaborators who land on a shared project but have no runner yet. Polls so
 * the onboarding clears itself within ~`pollMs` of the runner coming online.
 */

import { useEffect, useState } from 'react';

import { api } from '@/lib/api';

export function useRunnerStatus(pollMs = 15_000) {
  const [hasRunner, setHasRunner] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const result = await api.getMyRunners();
    if (result.isOk()) setHasRunner(result.value.runners.length > 0);
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const result = await api.getMyRunners();
      if (cancelled) return;
      if (result.isOk()) setHasRunner(result.value.runners.length > 0);
      setLoading(false);
    };
    poll();
    const id = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);

  return { hasRunner, loading, refresh };
}
