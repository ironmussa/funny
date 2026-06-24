/**
 * Hook that wraps `buildThreadPayload` with the stateful concerns every
 * call-site shared before this refactor: `creating` flag, error toasting,
 * telemetry, and the per-kind `api.create*Thread` call.
 *
 * Call-sites supply `onSuccess(threadId, kind)` so they can branch on the
 * `kind` for navigation / post-creation refreshes (scratch → /scratch/:id,
 * idle → list reload, normal → optional design-aware navigate).
 *
 * NOT responsible for: navigation, design-context awareness, sidebar
 * refresh, `justSubmittedRef`. Those stay at the call-site because they're
 * surface-specific.
 */

import { useCallback, useState } from 'react';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { metric, startSpan } from '@/lib/telemetry';
import { buildThreadPayload, type SubmitOpts, type ThreadKind } from '@/lib/thread-payload';
import { toastError } from '@/lib/toast-error';
import { type ToolPermission } from '@/stores/settings-store';

const log = createClientLogger('use-thread-creation');

export interface UseThreadCreationOptions {
  /** Project ID. May be null when isScratch is true. */
  projectId: string | null;
  defaultThreadMode: 'local' | 'worktree';
  toolPermissions: Record<string, ToolPermission>;
  /** Active design context — included in payload when defined. */
  designId?: string;
  /** Forces every submit through the scratch branch. */
  isScratch?: boolean;
  /** Forces idle (e.g. backlog-only screens). */
  forceIdle?: boolean;
  /** Stage to set on idle threads. */
  stage?: 'backlog' | 'planning';
  /**
   * Called after a successful create. `kind` tells the call-site which
   * branch was taken so navigation/refresh logic can differ.
   * Receives the created thread id; the thread object is whatever the
   * specific endpoint returned.
   */
  onSuccess?: (threadId: string, kind: ThreadKind, thread: any) => void | Promise<void>;
}

export interface UseThreadCreationResult {
  creating: boolean;
  /**
   * Submit a new thread. Returns `true` on success, `false` on error
   * (matching the existing PromptInput.onSubmit contract).
   */
  createThread: (prompt: string, opts: SubmitOpts, images?: any[]) => Promise<boolean>;
}

export function useThreadCreation(options: UseThreadCreationOptions): UseThreadCreationResult {
  const [creating, setCreating] = useState(false);
  const {
    projectId,
    isScratch,
    forceIdle,
    stage,
    defaultThreadMode,
    toolPermissions,
    designId,
    onSuccess,
  } = options;

  const createThread = useCallback(
    async (prompt: string, opts: SubmitOpts, images?: any[]): Promise<boolean> => {
      // Guard inside the hook so call-sites don't all reimplement it.
      if (creating) return false;

      // Capture toolPermissions/designId/stage fresh inside the callback
      // (not the render closure) — avoids stale values when the user toggles
      // permissions mid-compose.
      const built = (() => {
        try {
          return buildThreadPayload({
            projectId,
            prompt,
            opts,
            images,
            isScratch,
            forceIdle,
            stage,
            defaultThreadMode,
            toolPermissions,
            designId,
          });
        } catch (err) {
          log.error('buildThreadPayload threw', {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      })();

      if (!built) return false;

      setCreating(true);
      const span = startSpan('thread.create', {
        attributes: { kind: built.kind, model: opts.model },
      });

      try {
        const result =
          built.kind === 'scratch'
            ? await api.createScratchThread(built.payload)
            : built.kind === 'idle'
              ? await api.createIdleThread(built.payload)
              : await api.createThread(built.payload);

        if (result.isErr()) {
          toastError(result.error, 'createThread');
          metric('threads.create.error', 1, { type: 'sum', attributes: { kind: built.kind } });
          span.end('ERROR', result.error.message);
          setCreating(false);
          return false;
        }

        metric('threads.create.success', 1, { type: 'sum', attributes: { kind: built.kind } });
        span.end('OK');

        // Hand off to the call-site BEFORE flipping creating=false so the
        // loader UI stays mounted through any navigation the call-site
        // triggers (avoids a flash of the empty form).
        await onSuccess?.(result.value.id, built.kind, result.value);
        setCreating(false);
        return true;
      } catch (err) {
        log.error('thread create threw', {
          kind: built.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        span.end('ERROR', err instanceof Error ? err.message : String(err));
        setCreating(false);
        return false;
      }
    },
    [
      creating,
      projectId,
      isScratch,
      forceIdle,
      stage,
      defaultThreadMode,
      toolPermissions,
      designId,
      onSuccess,
    ],
  );

  return { creating, createThread };
}
