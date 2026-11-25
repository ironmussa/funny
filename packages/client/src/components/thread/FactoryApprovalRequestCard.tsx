import type { FactoryApprovalRequest } from '@funny/shared/contracts/factory';
/**
 * An agent's request that the member approve merging a high-risk change the
 * factory holds (openspec factory-agent-tools), as a card in the thread that
 * asked. Everything it shows comes from the run as the server classified it:
 * the agent supplied the run and nothing else. Approving is the board's own
 * approval (the member's session, the commit shown); declining closes the
 * request and leaves the run held.
 */
import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PRBadge } from '@/components/PRBadge';
import { pullRequestNumber, useFactoryRunActions } from '@/components/thread/FactoryRunControls';
import { Button } from '@/components/ui/button';
import { LabelBadge } from '@/components/ui/label-badge';
import { declineFactoryApprovalRequest } from '@/data/factory/actions';
import {
  useFactoryRuns,
  useFactorySettings,
  usePendingApprovalRequestsOfThread,
} from '@/data/factory/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import { isFactoryRunAwaitingMergeApproval } from '@/lib/factory-run-labels';
import { useThreadById } from '@/lib/thread-selectors';
import { canDoGitOps, isFactoryThread } from '@/lib/thread-variant';
import { toastError } from '@/lib/toast-error';

/** The pending approval requests the agent of this thread made, oldest first. */
export function FactoryApprovalRequestCards({ threadId }: { threadId?: string }) {
  const thread = useThreadById(threadId);
  // A scratch thread has no project, and a factory thread cannot ask.
  const projectId =
    thread?.projectId && canDoGitOps(thread) && !isFactoryThread(thread)
      ? thread.projectId
      : undefined;
  if (!threadId || !projectId) return null;
  return <ThreadApprovalRequests projectId={projectId} threadId={threadId} />;
}

function ThreadApprovalRequests({ projectId, threadId }: { projectId: string; threadId: string }) {
  // Only a member with a factory here is asked anything: nobody else polls.
  const settings = useFactorySettings(projectId);
  const requests = usePendingApprovalRequestsOfThread(projectId, threadId, !!settings);
  if (requests.length === 0) return null;
  return requests.map((request) => (
    <FactoryApprovalRequestCard key={request.id} projectId={projectId} request={request} />
  ));
}

function FactoryApprovalRequestCard({
  projectId,
  request,
}: {
  projectId: string;
  request: FactoryApprovalRequest;
}) {
  const { t } = useTranslation();
  const runs = useFactoryRuns(projectId);
  const run = runs?.find((candidate) => candidate.id === request.runId);

  return (
    <div
      className="border-status-warning/40 bg-status-warning/5 space-y-2 rounded-lg border px-3 py-2 text-xs"
      data-testid={`factory-approval-card-${request.id}`}
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="text-status-warning icon-sm shrink-0" />
        <span className="font-medium">
          {t('factory.approvalRequest.title', 'An agent asks you to approve this merge')}
        </span>
      </div>
      {run ? (
        <ApprovalRequestBody projectId={projectId} request={request} run={run} />
      ) : (
        <p className="text-muted-foreground">
          {t('factory.approvalRequest.loading', 'Reading the run…')}
        </p>
      )}
    </div>
  );
}

function ApprovalRequestBody({
  projectId,
  request,
  run,
}: {
  projectId: string;
  request: FactoryApprovalRequest;
  run: FactoryRun;
}) {
  const { t } = useTranslation();
  const { actions, dialog } = useFactoryRunActions(projectId, run);
  const approve = actions.find((action) => action.id === 'approve-merge');
  // The request is for one commit: once the run is held on another (or not
  // held), there is nothing here to approve. The server expires it too.
  const current = isFactoryRunAwaitingMergeApproval(run) && run.risk?.headSha === request.sha;
  const decline = () =>
    void declineFactoryApprovalRequest(projectId, request.id).orTee((error) =>
      toastError(error, 'factory'),
    );

  if (!current) {
    return (
      <p className="text-muted-foreground" data-testid={`factory-approval-stale-${request.id}`}>
        {t(
          'factory.approvalRequest.stale',
          'The pull request changed after the agent asked. This request no longer applies.',
        )}
      </p>
    );
  }

  return (
    <>
      <ApprovalRequestFacts request={request} run={run} />
      <p className="text-muted-foreground">
        {t(
          'factory.approvalRequest.asked',
          'The agent of this thread asked. Nothing is approved until you approve it here or on the factory board.',
        )}
      </p>
      {approve && (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={decline}
            data-testid={`factory-approval-decline-${request.id}`}
          >
            {t('factory.approvalRequest.decline', 'Decline')}
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={approve.run}
            data-testid={`factory-approval-approve-${request.id}`}
          >
            {approve.label}
          </Button>
        </div>
      )}
      {dialog}
    </>
  );
}

/** The run's own facts: issue, pull request, commit, size, and why the factory holds it. */
function ApprovalRequestFacts({
  request,
  run,
}: {
  request: FactoryApprovalRequest;
  run: FactoryRun;
}) {
  const { t } = useTranslation();
  const prNumber = run.prUrl ? pullRequestNumber(run.prUrl) : null;
  const reasons = run.risk?.reasons ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-foreground">
          {run.issueNumber === null
            ? t('factory.approvalRequest.noIssue', 'Run without an issue')
            : t('factory.approvalRequest.issue', 'Issue #{{issue}}', { issue: run.issueNumber })}
        </span>
        {run.prUrl && prNumber !== null && (
          <PRBadge
            prNumber={prNumber}
            prState="OPEN"
            prUrl={run.prUrl}
            variant="plain"
            data-testid={`factory-approval-pr-${request.id}`}
          />
        )}
        <span className="text-muted-foreground">
          {t('factory.approvalRequest.commit', 'Commit')}{' '}
          <code className="font-mono" data-testid={`factory-approval-sha-${request.id}`}>
            {request.sha.slice(0, 7)}
          </code>
        </span>
        {typeof run.risk?.changedLines === 'number' && (
          <span className="text-muted-foreground">
            {t('factory.approvalRequest.size', '{{count}} changed lines', {
              count: run.risk.changedLines,
            })}
          </span>
        )}
        <LabelBadge tone="warning">{run.risk?.level}</LabelBadge>
      </div>
      {reasons.length > 0 && (
        <div>
          <p className="text-muted-foreground">
            {t('factory.approvalRequest.reasons', 'Why the factory holds it')}
          </p>
          <ul
            className="text-foreground list-disc space-y-0.5 pl-4"
            data-testid={`factory-approval-reasons-${request.id}`}
          >
            {reasons.map((reason) => (
              <li key={reason} className="break-words">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
