import { useProjectStore } from '@/stores/project-store';
import { SCRATCH_TERMINAL_SCOPE_ID } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';

/**
 * Resolves the "terminal scope" — the id under which terminal tabs are
 * grouped and panel visibility is keyed. For a normal project thread this
 * is the project id; for a scratch thread there is no project, so we use
 * the synthetic {@link SCRATCH_TERMINAL_SCOPE_ID} sentinel and surface the
 * scratch thread id so the runner can derive the actual cwd.
 *
 * Returns `{ scopeId: null, scratchThreadId: null }` when neither a
 * project nor an active scratch thread is selected — callers should noop
 * in that case.
 */
export interface TerminalScope {
  scopeId: string | null;
  scratchThreadId: string | null;
}

export function useTerminalScope(): TerminalScope {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const activeThreadProjectId = useThreadStore((s) => s.activeThread?.projectId ?? null);
  const activeThreadIsScratch = useThreadStore((s) => !!s.activeThread?.isScratch);
  const activeThreadId = useThreadStore((s) => s.activeThread?.id ?? null);

  if (activeThreadIsScratch && activeThreadId) {
    return { scopeId: SCRATCH_TERMINAL_SCOPE_ID, scratchThreadId: activeThreadId };
  }
  const scopeId = selectedProjectId ?? activeThreadProjectId;
  return { scopeId, scratchThreadId: null };
}

/** Imperative version for non-React callers (effect callbacks, store actions). */
export function getTerminalScope(): TerminalScope {
  const selectedProjectId = useProjectStore.getState().selectedProjectId;
  const active = useThreadStore.getState().activeThread;
  if (active?.isScratch) {
    return { scopeId: SCRATCH_TERMINAL_SCOPE_ID, scratchThreadId: active.id };
  }
  const scopeId = selectedProjectId ?? active?.projectId ?? null;
  return { scopeId, scratchThreadId: null };
}
