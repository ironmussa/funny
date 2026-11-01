import type { Thread } from '@funny/shared';
import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { ThreadSandboxInfo, ThreadSandboxState } from '@/lib/api/infra';
import { createClientLogger } from '@/lib/client-logger';
import type { GitProgressStep } from '@/lib/git-progress-types';
import { runsInSandbox } from '@/lib/thread-variant';

const log = createClientLogger('sandbox-setup');

const POLL_MS = 3_000;

/** Provisioning phases in order, with the sandbox state that marks each one as current. */
const PHASES: Array<{ id: string; label: string; states: ThreadSandboxState[] }> = [
  { id: 'machine', label: 'Creating sandbox', states: ['provisioning'] },
  { id: 'runner', label: 'Installing runner', states: ['installing'] },
  { id: 'connect', label: 'Connecting runner', states: ['connecting'] },
  { id: 'checkout', label: 'Cloning project', states: ['bootstrapping'] },
  { id: 'agent', label: 'Starting agent', states: ['running'] },
];

/** Maps a sandbox's lifecycle state to the setup steps shown while a thread prepares. */
export function sandboxSetupSteps(info: Pick<ThreadSandboxInfo, 'state' | 'error'> | null) {
  if (!info) return [];
  const failed = info.state === 'failed' || info.state === 'lost';
  let current = PHASES.findIndex((p) => p.states.includes(info.state));
  // A failed sandbox does not say where it failed; mark the first unfinished phase.
  if (current === -1) current = failed ? 0 : PHASES.length - 1;
  return PHASES.map((phase, index): GitProgressStep => ({
    id: phase.id,
    label: phase.label,
    status:
      index < current
        ? 'completed'
        : index === current
          ? failed
            ? 'failed'
            : 'running'
          : 'pending',
    ...(failed && index === current && info.error ? { error: info.error } : {}),
  }));
}

/**
 * Setup steps for a sandbox thread that is still being prepared (change
 * thread-sandboxes), polled from the server. Returns null for any other thread
 * so the caller falls back to its own setup progress.
 */
export function useSandboxSetupSteps(thread: {
  id: string;
  runtime?: Thread['runtime'];
  status: string;
}): GitProgressStep[] | null {
  const preparing = thread.status === 'setting_up';
  // A failed setup is read once, to show where it failed and why.
  const active = runsInSandbox(thread) && (preparing || thread.status === 'failed');
  const [info, setInfo] = useState<ThreadSandboxInfo | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const poll = async () => {
      const res = await api.getThreadSandbox(thread.id);
      if (cancelled) return;
      if (res.isOk()) setInfo(res.value);
      // 404 until the server has written the sandbox row; keep polling.
      else if (res.error.type !== 'NOT_FOUND') {
        log.warn('failed to load sandbox state', { threadId: thread.id, error: res.error.message });
      }
    };
    void poll();
    const timer = preparing ? setInterval(poll, POLL_MS) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, preparing, thread.id]);

  return active ? sandboxSetupSteps(info) : null;
}
