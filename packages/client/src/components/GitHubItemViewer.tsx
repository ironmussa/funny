import type { EnrichedGitHubIssue, GitHubPR, PRDetail } from '@funny/shared';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IssueDetailDialog } from '@/components/IssueDetailDialog';
import { PRDetailDialog } from '@/components/PRDetailDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { LoadingState } from '@/components/ui/loading-state';
import { usePRDetail } from '@/data/pull-requests/hooks';
import { fetchPRDetail } from '@/data/pull-requests/queries';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import {
  type GitHubItemTarget,
  githubRepoOfUrl,
  useGitHubItemViewerStore,
} from '@/stores/github-item-viewer-store';

const log = createClientLogger('github-item-viewer');

/** The PR the dialog shows until (and around) its detail: the number and URL the chip knew. */
function prFromTarget(target: GitHubItemTarget, detail: PRDetail | undefined): GitHubPR {
  return {
    number: target.number,
    title: detail?.title ?? `#${target.number}`,
    body: detail?.body ?? null,
    state: detail?.state ?? 'open',
    html_url: detail?.html_url ?? target.url ?? '',
    user: detail?.user ?? null,
    created_at: detail?.created_at ?? '',
    updated_at: detail?.updated_at ?? '',
    head: { ref: detail?.head.ref ?? '', label: detail?.head.ref ?? '', sha: detail?.head.sha },
    base: { ref: detail?.base.ref ?? '', label: detail?.base.ref ?? '' },
    draft: detail?.draft ?? false,
    merged_at: detail?.merged ? (detail.updated_at ?? null) : null,
    labels: [],
  };
}

/**
 * The chip's URL names another repository than the project's: the project's
 * PR of that number is not the one the chip shows, so GitHub opens instead.
 */
function isOtherRepository(target: GitHubItemTarget, resolvedUrl: string | undefined): boolean {
  const wanted = githubRepoOfUrl(target.url);
  const resolved = githubRepoOfUrl(resolvedUrl);
  return wanted !== null && resolved !== null && wanted !== resolved;
}

function PRViewer({ target, onClose }: { target: GitHubItemTarget; onClose: () => void }) {
  const { detail } = usePRDetail(target.projectId, target.number);

  useEffect(() => {
    void fetchPRDetail(target.projectId, target.number);
  }, [target.projectId, target.number]);

  const otherRepository = isOtherRepository(target, detail?.html_url);
  useEffect(() => {
    if (!otherRepository || !target.url) return;
    log.info('item is in another repository; opening GitHub');
    window.open(target.url, '_blank', 'noopener,noreferrer');
    onClose();
  }, [otherRepository, target.url, onClose]);
  if (otherRepository) return null;

  return (
    <PRDetailDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      projectId={target.projectId}
      pr={prFromTarget(target, detail)}
    />
  );
}

type IssueState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; issue: EnrichedGitHubIssue };

function IssueViewer({ target, onClose }: { target: GitHubItemTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const key = `${target.projectId}#${target.number}`;
  const [loaded, setLoaded] = useState<{ key: string; state: IssueState } | null>(null);
  const state: IssueState = loaded?.key === key ? loaded.state : { status: 'loading' };

  useEffect(() => {
    let cancelled = false;
    const requestKey = `${target.projectId}#${target.number}`;
    void api.githubIssue(target.projectId, target.number).then((result) => {
      if (cancelled) return;
      if (result.isErr()) {
        log.warn('failed to load issue', {
          projectId: target.projectId,
          issueNumber: target.number,
          error: result.error.message,
        });
      }
      setLoaded({
        key: requestKey,
        state: result.isOk()
          ? { status: 'ready', issue: result.value.issue }
          : { status: 'error', message: result.error.message },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [target.projectId, target.number]);

  const otherRepository =
    state.status === 'ready' && isOtherRepository(target, state.issue.html_url);
  useEffect(() => {
    if (!otherRepository || !target.url) return;
    log.info('item is in another repository; opening GitHub');
    window.open(target.url, '_blank', 'noopener,noreferrer');
    onClose();
  }, [otherRepository, target.url, onClose]);
  if (otherRepository) return null;

  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  if (state.status === 'ready') {
    return (
      <IssueDetailDialog
        open
        onOpenChange={onOpenChange}
        projectId={target.projectId}
        issue={state.issue}
      />
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="github-item-viewer-issue-pending">
        <DialogTitle size="sm">
          {t('githubItemViewer.issueTitle', 'Issue #{{number}}', { number: target.number })}
        </DialogTitle>
        {state.status === 'loading' ? (
          <>
            <DialogDescription className="sr-only">
              {t('githubItemViewer.loading', 'Loading…')}
            </DialogDescription>
            <LoadingState
              label={t('githubItemViewer.loading', 'Loading…')}
              testId="github-item-viewer-loading"
            />
          </>
        ) : (
          <>
            <DialogDescription data-testid="github-item-viewer-error">
              {state.message}
            </DialogDescription>
            {target.url && (
              <Button asChild variant="outline" size="sm" className="self-start">
                <a
                  href={target.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="github-item-viewer-open-github"
                >
                  <ExternalLink className="icon-sm" aria-hidden="true" />
                  {t('githubItemViewer.openOnGithub', 'Open on GitHub')}
                </a>
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The pull request or issue a chip asked to show, in funny's own dialog
 * (mounted once by `OverlayDialogs`).
 */
export function GitHubItemViewer() {
  const target = useGitHubItemViewerStore((s) => s.target);
  const close = useGitHubItemViewerStore((s) => s.close);
  if (!target) return null;
  const key = `${target.kind}:${target.projectId}:${target.number}`;
  return target.kind === 'pr' ? (
    <PRViewer key={key} target={target} onClose={close} />
  ) : (
    <IssueViewer key={key} target={target} onClose={close} />
  );
}
