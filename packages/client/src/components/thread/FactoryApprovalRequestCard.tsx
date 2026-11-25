/**
 * An agent's request that the member approve merging a high-risk change the
 * factory holds (openspec factory-agent-tools), as a card in the thread, at
 * the moment the agent asked. Everything it shows comes from the run as the
 * server classified it: the agent supplied the run and nothing else.
 *
 * While pending it offers the board's own approval (the member's session, the
 * commit shown) or a decline. Once answered it stays as a record and says what
 * the run is doing now, since an approved run may still wait its turn.
 */
import type { FactoryApprovalRequest } from '@funny/shared/contracts/factory';
import { CircleCheck, CircleSlash, Clock, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { factoryRunStateChip } from '@/components/factory-board/run-state-chip';
import { factoryRunWaitingText } from '@/components/factory-board/run-waiting';
import { PRBadge } from '@/components/PRBadge';
import { pullRequestNumber, useFactoryRunActions } from '@/components/thread/FactoryRunControls';
import { Button } from '@/components/ui/button';
import { LabelBadge } from '@/components/ui/label-badge';
import { declineFactoryApprovalRequest } from '@/data/factory/actions';
import { useFactoryApprovalRequests, useFactoryRuns } from '@/data/factory/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import { isFactoryRunAwaitingMergeApproval } from '@/lib/factory-run-labels';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

type Outcome = 'pending' | 'approved' | 'declined' | 'expired';

const FRAME: Record<Outcome, string> = {
  pending: 'border-status-warning/40 bg-status-warning/5',
  approved: 'bg-card',
  declined: 'bg-card',
  expired: 'bg-card',
};

function OutcomeIcon({ outcome }: { outcome: Outcome }) {
  if (outcome === 'pending') {
    return <ShieldAlert className="text-status-warning icon-sm shrink-0" />;
  }
  if (outcome === 'approved') {
    return <CircleCheck className="text-status-success icon-sm shrink-0" />;
  }
  if (outcome === 'declined') {
    return <CircleSlash className="text-muted-foreground icon-sm shrink-0" />;
  }
  return <Clock className="text-muted-foreground icon-sm shrink-0" />;
}

const TITLE: Record<Outcome, { key: string; fallback: string }> = {
  pending: {
    key: 'factory.approvalRequest.title',
    fallback: 'Approval needed to merge #{{issue}}',
  },
  approved: {
    key: 'factory.approvalRequest.approvedTitle',
    fallback: 'You approved merging #{{issue}}',
  },
  declined: {
    key: 'factory.approvalRequest.declinedTitle',
    fallback: 'You declined to approve #{{issue}}',
  },
  expired: {
    key: 'factory.approvalRequest.expiredTitle',
    fallback: 'The request to approve #{{issue}} expired',
  },
};

/**
 * What the card shows: the stored state, except that a pending request for a
 * commit the run is no longer held on reads as expired at once (the server
 * expires it on its next read).
 */
function outcomeOf(request: FactoryApprovalRequest, run: FactoryRun): Outcome {
  if (request.state !== 'pending') return request.state;
  const current = isFactoryRunAwaitingMergeApproval(run) && run.risk?.headSha === request.sha;
  return current ? 'pending' : 'expired';
}

export function FactoryApprovalRequestCard({
  projectId,
  requestId,
}: {
  projectId: string;
  requestId: string;
}) {
  const { t } = useTranslation();
  const request = useFactoryApprovalRequests(projectId)?.find((item) => item.id === requestId);
  const runs = useFactoryRuns(projectId);
  if (!request) return null;
  const run = runs?.find((candidate) => candidate.id === request.runId);
  if (!run) {
    return (
      <CardFrame id={request.id} outcome="pending" title={null}>
        <p className="text-muted-foreground">
          {t('factory.approvalRequest.loading', 'Reading the run…')}
        </p>
      </CardFrame>
    );
  }
  const outcome = outcomeOf(request, run);
  const title =
    run.issueNumber === null && outcome === 'pending'
      ? t('factory.approvalRequest.titleNoIssue', 'Approval needed to merge this run')
      : t(TITLE[outcome].key, TITLE[outcome].fallback, { issue: run.issueNumber ?? '' });
  return (
    <CardFrame id={request.id} outcome={outcome} title={title}>
      <RunFacts request={request} run={run} />
      {outcome === 'pending' ? (
        <PendingBody projectId={projectId} request={request} run={run} />
      ) : (
        <AnsweredBody outcome={outcome} request={request} run={run} />
      )}
    </CardFrame>
  );
}

function CardFrame({
  id,
  outcome,
  title,
  children,
}: {
  id: string;
  outcome: Outcome;
  title: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn('space-y-2 rounded-lg border px-3 py-2.5 text-xs', FRAME[outcome])}
      data-testid={`factory-approval-card-${id}`}
      data-outcome={outcome}
    >
      <div className="flex items-center gap-2">
        <OutcomeIcon outcome={outcome} />
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {outcome === 'pending' && title && (
          <LabelBadge tone="danger">
            {t('factory.approvalRequest.highRisk', 'High risk')}
          </LabelBadge>
        )}
      </div>
      {children}
    </div>
  );
}

/** One muted line: the pull request, the commit asked about, and the size of the change. */
function RunFacts({ request, run }: { request: FactoryApprovalRequest; run: FactoryRun }) {
  const { t } = useTranslation();
  const prNumber = run.prUrl ? pullRequestNumber(run.prUrl) : null;
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
      {run.prUrl && prNumber !== null && (
        <PRBadge
          prNumber={prNumber}
          prState={run.state === 'merged' ? 'MERGED' : 'OPEN'}
          prUrl={run.prUrl}
          variant="plain"
          data-testid={`factory-approval-pr-${request.id}`}
        />
      )}
      <span className="flex items-center gap-1">
        {t('factory.approvalRequest.commit', 'commit')}
        <code
          className="bg-muted text-foreground rounded px-1 py-px font-mono"
          data-testid={`factory-approval-sha-${request.id}`}
        >
          {request.sha.slice(0, 7)}
        </code>
      </span>
      {typeof run.risk?.changedLines === 'number' && run.risk.headSha === request.sha && (
        <span>
          {t('factory.approvalRequest.size', '{{count}} changed lines', {
            count: run.risk.changedLines,
          })}
        </span>
      )}
    </div>
  );
}

function PendingBody({
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
  const reasons = run.risk?.reasons ?? [];
  const decline = () =>
    void declineFactoryApprovalRequest(projectId, request.id).orTee((error) =>
      toastError(error, 'factory'),
    );
  return (
    <>
      {reasons.length > 0 && (
        <div className="space-y-1">
          <p className="text-muted-foreground font-medium">
            {t('factory.approvalRequest.reasons', 'Why the factory holds it')}
          </p>
          <ul
            className="text-foreground marker:text-muted-foreground list-disc space-y-1 pl-4 leading-snug"
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
        <p className="text-muted-foreground min-w-0">
          {t(
            'factory.approvalRequest.asked',
            'Asked by the agent of this thread. Nothing is approved until you approve it.',
          )}
        </p>
        {approve && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
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
      </div>
      {dialog}
    </>
  );
}

/** After the answer: what was decided and, when approved, what the run is doing now. */
function AnsweredBody({
  outcome,
  request,
  run,
}: {
  outcome: Exclude<Outcome, 'pending'>;
  request: FactoryApprovalRequest;
  run: FactoryRun;
}) {
  const { t } = useTranslation();
  if (outcome === 'expired') {
    return (
      <p className="text-muted-foreground" data-testid={`factory-approval-stale-${request.id}`}>
        {t(
          'factory.approvalRequest.stale',
          'The pull request changed after the agent asked, so this request no longer applies.',
        )}
      </p>
    );
  }
  if (outcome === 'declined') {
    return (
      <p className="text-muted-foreground">
        {t('factory.approvalRequest.declinedNote', 'Nothing was approved. The run stays held.')}
      </p>
    );
  }
  // An approved run may not start at once: it can wait for a slot or for a run
  // that changes the same files. Say which, so the approval does not look lost.
  const state = factoryRunStateChip(t, run);
  const waiting = factoryRunWaitingText(t, run);
  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid={`factory-approval-run-now-${request.id}`}
    >
      <span>{t('factory.approvalRequest.runNow', 'The run now:')}</span>
      <LabelBadge tone={state.tone}>{state.label}</LabelBadge>
      {waiting && <span className="text-foreground min-w-0">{waiting}</span>}
    </div>
  );
}
