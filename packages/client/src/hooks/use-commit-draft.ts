import { useCallback, useEffect, useRef, useState } from 'react';

import { useDraftStore } from '@/stores/draft-store';

export interface UseCommitDraftResult {
  commitTitle: string;
  commitBody: string;
  setCommitTitle: (v: string | ((prev: string) => string)) => void;
  setCommitBody: (v: string | ((prev: string) => string)) => void;
  /** Always-current value, safe to read inside async callbacks without re-binding. */
  commitTitleRef: React.MutableRefObject<string>;
  commitBodyRef: React.MutableRefObject<string>;
}

/**
 * Owns the in-progress commit draft (title + body) for a single git context
 * (thread or project). Persists every keystroke to the global draft store and
 * restores from it whenever the draft id changes (e.g. thread switch).
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function useCommitDraft(draftId: string | null | undefined): UseCommitDraftResult {
  const { setCommitDraft } = useDraftStore();

  const [commitTitle, setCommitTitleRaw] = useState('');
  const [commitBody, setCommitBodyRaw] = useState('');

  // Always-current refs so the auto-persist setters can read the *other*
  // field's latest value without nesting setStates.
  const commitTitleRef = useRef(commitTitle);
  commitTitleRef.current = commitTitle;
  const commitBodyRef = useRef(commitBody);
  commitBodyRef.current = commitBody;

  const setCommitTitle = useCallback(
    (v: string | ((prev: string) => string)) => {
      setCommitTitleRaw((prev) => {
        const next = typeof v === 'function' ? v(prev) : v;
        if (draftId) {
          setCommitDraft(draftId, next, commitBodyRef.current);
        }
        return next;
      });
    },
    [draftId, setCommitDraft],
  );

  const setCommitBody = useCallback(
    (v: string | ((prev: string) => string)) => {
      setCommitBodyRaw((prev) => {
        const next = typeof v === 'function' ? v(prev) : v;
        if (draftId) {
          setCommitDraft(draftId, commitTitleRef.current, next);
        }
        return next;
      });
    },
    [draftId, setCommitDraft],
  );

  // Restore the draft (or clear) whenever the git context changes.
  useEffect(() => {
    const draft = draftId ? useDraftStore.getState().drafts[draftId] : undefined;
    setCommitTitleRaw(draft?.commitTitle ?? '');
    setCommitBodyRaw(draft?.commitBody ?? '');
  }, [draftId]);

  return {
    commitTitle,
    commitBody,
    setCommitTitle,
    setCommitBody,
    commitTitleRef,
    commitBodyRef,
  };
}
