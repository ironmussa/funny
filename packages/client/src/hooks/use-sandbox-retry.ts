import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { SubmitFn } from '@/hooks/prompt-input-types';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildSendMessagePayload } from '@/lib/send-message-payload';
import { useSettingsStore } from '@/stores/settings-store';

const log = createClientLogger('sandbox-retry');

/**
 * Submit handler for a sandbox thread whose setup failed: the message the user
 * writes retries the sandbox (the server provisions a new one and starts the
 * agent with the initial prompt plus this message). The thread's status moves
 * back to `setting_up` through the server's `thread:updated` event.
 */
export function useSandboxRetry(threadId: string): { retry: SubmitFn; retrying: boolean } {
  const [retrying, setRetrying] = useState(false);
  const inFlightRef = useRef(false);

  const retry = useCallback<SubmitFn>(
    async (prompt, opts, images) => {
      if (inFlightRef.current) return false;
      inFlightRef.current = true;
      setRetrying(true);
      try {
        const payload = buildSendMessagePayload(opts, useSettingsStore.getState().toolPermissions);
        const result = await api.retrySandboxThread(threadId, prompt, payload, images);
        if (result.isErr()) {
          log.warn('sandbox retry refused', { threadId, error: result.error.message });
          toast.error(result.error.message);
          return false;
        }
        log.info('sandbox retry started', { threadId });
        return true;
      } finally {
        inFlightRef.current = false;
        setRetrying(false);
      }
    },
    [threadId],
  );

  return { retry, retrying };
}
