import type { JsonValidationResult } from '@funny/shared/json-validation';
import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('progress-file');

/** How often a running progress file is re-read. */
export const PROGRESS_POLL_MS = 1_000;

export type ProgressFileState<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; progress: T };

/**
 * Follows a progress file a runner rewrites while it runs (test or task
 * progress): reads it through the open thread's runner, and again every second
 * while `isRunning` says the run is still going. Keeps the last good snapshot
 * when a read fails mid-run (the file is replaced atomically, but the runner can
 * be briefly unreachable).
 */
export function useProgressFile<T>(
  path: string | null,
  parse: (raw: string) => JsonValidationResult<T>,
  isRunning: (progress: T) => boolean,
): ProgressFileState<T> {
  const [state, setState] = useState<ProgressFileState<T>>({ kind: 'loading' });

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hasSnapshot = false;
    let warned = false;

    const poll = async () => {
      const result = await api.readFile(path);
      if (cancelled) return;
      const parsed = result.isOk()
        ? parse(result.value.content)
        : { ok: false as const, error: result.error.message };

      if (parsed.ok) {
        hasSnapshot = true;
        setState({ kind: 'ready', progress: parsed.value });
      } else if (hasSnapshot) {
        // Mid-run failures are expected noise (runner hiccup): keep the last snapshot.
        log.debug('progress read failed, keeping last snapshot', { path, error: parsed.error });
      } else {
        if (!warned) log.warn('progress file unreadable', { path, error: parsed.error });
        warned = true;
        setState({ kind: 'error', message: parsed.error });
      }

      if (!parsed.ok || isRunning(parsed.value)) {
        timer = setTimeout(poll, PROGRESS_POLL_MS);
      } else {
        log.info('run finished', { path });
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Callers pass module-level `parse` / `isRunning`, so they never change.
  }, [path, parse, isRunning]);

  return path ? state : { kind: 'error', message: 'invalid' };
}
