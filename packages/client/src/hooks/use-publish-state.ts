import { useEffect, useState } from 'react';

import { gitApi } from '@/lib/api/git';

interface UsePublishStateArgs {
  /** Project id used to look up the remote (project-mode or the thread's project). */
  remoteCheckProjectId: string | null;
  /** When true, we know a remote exists without needing the API call. */
  hasRemoteBranch: boolean | undefined;
}

export interface UsePublishStateResult {
  /**
   * `undefined` = unknown / loading,
   * `null` = no remote configured,
   * `'exists'` = remote branch already exists (skip lookup),
   * `string` = the resolved remote URL.
   */
  remoteUrl: string | null | undefined;
  publishDialogOpen: boolean;
  setPublishDialogOpen: (open: boolean) => void;
}

/**
 * Owns the publish-to-remote state for ReviewPane: tracks whether a remote
 * is configured (so we can show "Publish" vs "Push") and the dialog open flag.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function usePublishState({
  remoteCheckProjectId,
  hasRemoteBranch,
}: UsePublishStateArgs): UsePublishStateResult {
  const [remoteUrl, setRemoteUrl] = useState<string | null | undefined>(undefined);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);

  useEffect(() => {
    if (!remoteCheckProjectId) {
      setRemoteUrl(undefined);
      return;
    }
    if (hasRemoteBranch) {
      setRemoteUrl('exists');
      return;
    }
    const controller = new AbortController();
    gitApi.projectGetRemoteUrl(remoteCheckProjectId, controller.signal).then((r) => {
      if (!controller.signal.aborted && r.isOk()) {
        setRemoteUrl(r.value.remoteUrl);
      }
    });
    return () => controller.abort();
  }, [remoteCheckProjectId, hasRemoteBranch]);

  return { remoteUrl, publishDialogOpen, setPublishDialogOpen };
}
