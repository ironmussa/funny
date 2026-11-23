import { useCallback, useEffect, useRef, useState } from 'react';

import type { GraphEntry } from '@/components/commit-graph/graph-entry';
import { api } from '@/lib/api';
import type { GitRebaseReflogEventDTO } from '@/lib/api/git';
import { createClientLogger } from '@/lib/client-logger';
import { githubBrowseBaseUrl as resolveGithubBrowseBaseUrl } from '@/lib/github-url';

const log = createClientLogger('commit-graph');

/** Rebases recorded in the local reflog, and the one whose details dialog is open. */
export function useRebaseEvents({
  visible,
  hasGitContext,
  effectiveThreadId,
  projectModeId,
}: {
  visible: boolean | undefined;
  hasGitContext: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
}) {
  const [rebaseEvents, setRebaseEvents] = useState<GitRebaseReflogEventDTO[]>([]);
  const [selectedRebaseEvent, setSelectedRebaseEvent] = useState<GitRebaseReflogEventDTO | null>(
    null,
  );
  const resetRebaseEvents = useCallback(() => {
    setRebaseEvents([]);
    setSelectedRebaseEvent(null);
  }, []);

  useEffect(() => {
    if (!visible || !hasGitContext) return;
    const controller = new AbortController();
    const request = effectiveThreadId
      ? api.getReflogEvents(effectiveThreadId, controller.signal)
      : api.projectReflogEvents(projectModeId!, controller.signal);
    request.then((result) => {
      if (controller.signal.aborted) return;
      if (result.isOk()) {
        setRebaseEvents(result.value.events);
      } else if (result.error.message !== 'Request aborted') {
        log.warn('reflog-events load failed', { error: result.error.message });
        setRebaseEvents([]);
      }
    });
    return () => controller.abort();
  }, [visible, hasGitContext, effectiveThreadId, projectModeId]);

  return { rebaseEvents, selectedRebaseEvent, setSelectedRebaseEvent, resetRebaseEvents };
}

/** The GitHub browse base URL of the project's remote, so commit hashes can deep-link. */
export function useGithubBrowseBaseUrl(projectId: string | null | undefined): string | null {
  const [githubBrowseBaseUrl, setGithubBrowseBaseUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) {
      setGithubBrowseBaseUrl(null);
      return;
    }
    const controller = new AbortController();
    api.projectGetRemoteUrl(projectId, controller.signal).then((r) => {
      if (controller.signal.aborted || !r.isOk()) return;
      setGithubBrowseBaseUrl(resolveGithubBrowseBaseUrl(r.value.remoteUrl));
    });
    return () => controller.abort();
  }, [projectId]);
  return githubBrowseBaseUrl;
}

/**
 * GitHub avatar URL per commit SHA. Walks the GitHub commit-author endpoint,
 * anchored at the first uncovered SHA, to fill in avatar URLs; resets when the
 * git context changes.
 */
export function useGithubCommitAvatars(
  projectId: string | null | undefined,
  entries: GraphEntry[],
  gitContextKey: string,
): Map<string, string> {
  const [githubAvatarBySha, setGithubAvatarBySha] = useState<Map<string, string>>(new Map());
  const anchoredShasRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    setGithubAvatarBySha(new Map());
    anchoredShasRef.current = new Set();
  }, [gitContextKey]);

  useEffect(() => {
    if (!projectId || entries.length === 0) return;
    const firstMissing = entries.find(
      (e) => !githubAvatarBySha.has(e.hash) && !anchoredShasRef.current.has(e.hash),
    );
    if (!firstMissing) return;
    anchoredShasRef.current.add(firstMissing.hash);
    let cancelled = false;
    api
      .githubCommitAuthors(projectId, {
        sha: firstMissing.hash,
        per_page: 100,
      })
      .then((result) => {
        if (cancelled || result.isErr()) return;
        const authors = result.value.authors;
        if (authors.length === 0) return;
        setGithubAvatarBySha((prev) => {
          const next = new Map(prev);
          for (const a of authors) if (a.avatar_url) next.set(a.sha, a.avatar_url);
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, entries, githubAvatarBySha]);
  return githubAvatarBySha;
}
