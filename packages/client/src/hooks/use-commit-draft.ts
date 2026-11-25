import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { useAdjustOnChange } from '@/hooks/use-resettable-state';
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

function isUpdater(value: string | ((prev: string) => string)): value is (prev: string) => string {
  return typeof value === 'function';
}

/**
 * Owns the in-progress commit draft (title + body) for a single git context
 * (thread or project). Persists every keystroke to the global draft store and
 * restores from it whenever the draft id changes (e.g. thread switch).
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
function readDraft(draftId: string | null | undefined) {
  return draftId ? useDraftStore.getState().drafts[draftId] : undefined;
}

export function useCommitDraft(draftId: string | null | undefined): UseCommitDraftResult {
  const { setCommitDraft } = useDraftStore();

  const [commitTitle, setCommitTitleRaw] = useState(() => readDraft(draftId)?.commitTitle ?? '');
  const [commitBody, setCommitBodyRaw] = useState(() => readDraft(draftId)?.commitBody ?? '');

  // Restore the draft (or clear) whenever the git context changes. Adjusted
  // during render (react.dev "adjusting state when a prop changes"), so the
  // previous context's draft is never painted for the new one.
  useAdjustOnChange([draftId], () => {
    const draft = readDraft(draftId);
    setCommitTitleRaw(draft?.commitTitle ?? '');
    setCommitBodyRaw(draft?.commitBody ?? '');
  });

  // Always-current refs so the auto-persist setters can read the *other*
  // field's latest value without nesting setStates.
  const commitTitleRef = useRef(commitTitle);
  const commitBodyRef = useRef(commitBody);
  useLayoutEffect(() => {
    commitTitleRef.current = commitTitle;
    commitBodyRef.current = commitBody;
  }, [commitBody, commitTitle]);

  const setCommitTitle = useCallback(
    (v: string | ((prev: string) => string)) => {
      setCommitTitleRaw((prev) => {
        const next = isUpdater(v) ? v(prev) : v;
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
        const next = isUpdater(v) ? v(prev) : v;
        if (draftId) {
          setCommitDraft(draftId, commitTitleRef.current, next);
        }
        return next;
      });
    },
    [draftId, setCommitDraft],
  );

  return {
    commitTitle,
    commitBody,
    setCommitTitle,
    setCommitBody,
    commitTitleRef,
    commitBodyRef,
  };
}
