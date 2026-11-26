/**
 * An agent's request that the member approve a run's spec draft (openspec
 * factory-spec-stage), as a card in the thread at the moment the agent asked.
 * What it shows is the run's stored draft for the revision the agent named,
 * never text the agent supplied. Approving goes through the member's own
 * session (`approveFactorySpec`, pinned to that revision); the request itself
 * approves nothing.
 */
import type { FactoryApprovalRequest } from '@funny/shared/contracts/factory';
import { CircleCheck, CircleSlash, Clock, FileText } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SpecBody } from '@/components/factory-board/run-detail/RunSpec';
import { factoryRunStateChip } from '@/components/factory-board/run-state-chip';
import { Button } from '@/components/ui/button';
import { LabelBadge } from '@/components/ui/label-badge';
import { approveFactorySpec, declineFactoryApprovalRequest } from '@/data/factory/actions';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

type Outcome = 'pending' | 'approved' | 'declined' | 'expired';

/**
 * The stored state, except that a pending request whose draft is no longer
 * the run's latest (a newer revision, or the run left `needs_spec`) reads as
 * expired at once; the server expires it on its next read.
 */
export function specRequestOutcome(request: FactoryApprovalRequest, run: FactoryRun): Outcome {
  if (request.state !== 'pending') return request.state;
  const current =
    run.state === 'needs_spec' &&
    run.spec?.latest?.status === 'draft' &&
    run.spec.revision === request.specRevision;
  return current ? 'pending' : 'expired';
}

function OutcomeIcon({ outcome }: { outcome: Outcome }) {
  if (outcome === 'pending') return <FileText className="text-status-warning icon-sm shrink-0" />;
  if (outcome === 'approved') {
    return <CircleCheck className="text-status-success icon-sm shrink-0" />;
  }
  if (outcome === 'declined') {
    return <CircleSlash className="text-muted-foreground icon-sm shrink-0" />;
  }
  return <Clock className="text-muted-foreground icon-sm shrink-0" />;
}

export function FactorySpecRequestCard({
  projectId,
  request,
  run,
}: {
  projectId: string;
  request: FactoryApprovalRequest;
  run: FactoryRun;
}) {
  const { t } = useTranslation();
  const canSteer = useCanSteerProject(projectId);
  const [busy, setBusy] = useState(false);
  const outcome = specRequestOutcome(request, run);
  const issue = run.issueNumber ?? '';
  const title = {
    pending: t('factory.specRequest.title', 'Spec of #{{issue}} waits for your approval', {
      issue,
    }),
    approved: t('factory.specRequest.approvedTitle', 'You approved the spec of #{{issue}}', {
      issue,
    }),
    declined: t('factory.specRequest.declinedTitle', 'You declined the spec of #{{issue}}', {
      issue,
    }),
    expired: t('factory.specRequest.expiredTitle', 'The request to approve the spec expired'),
  }[outcome];
  const draft = run.spec?.latest?.status === 'draft' ? run.spec.latest.spec : null;
  const revision = request.specRevision ?? -1;

  const approve = () => {
    setBusy(true);
    void approveFactorySpec(projectId, run.id, revision)
      .orTee((error) => toastError(error, 'factoryApproveSpec'))
      .andTee(() => setBusy(false))
      .orTee(() => setBusy(false));
  };
  const decline = () =>
    void declineFactoryApprovalRequest(projectId, request.id).orTee((error) =>
      toastError(error, 'factory'),
    );

  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border px-3 py-2.5 text-xs',
        outcome === 'pending' ? 'border-status-warning/40 bg-status-warning/5' : 'bg-card',
      )}
      data-testid={`factory-spec-request-card-${request.id}`}
      data-outcome={outcome}
    >
      <div className="flex items-center gap-2">
        <OutcomeIcon outcome={outcome} />
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      </div>
      {outcome === 'pending' && draft && (
        <>
          <SpecBody spec={draft} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
            <p className="text-muted-foreground min-w-0">
              {t(
                'factory.specRequest.asked',
                'Asked by the agent of this thread. Nothing is approved until you approve it.',
              )}
            </p>
            {canSteer && (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={decline}
                  data-testid={`factory-spec-request-decline-${request.id}`}
                >
                  {t('factory.approvalRequest.decline', 'Decline')}
                </Button>
                <Button
                  variant="default"
                  size="xs"
                  disabled={busy}
                  onClick={approve}
                  data-testid={`factory-spec-request-approve-${request.id}`}
                >
                  {t('factorySpec.approve', 'Approve spec')}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      {outcome === 'expired' && (
        <p
          className="text-muted-foreground"
          data-testid={`factory-spec-request-stale-${request.id}`}
        >
          {t(
            'factory.specRequest.stale',
            'The spec changed after the agent asked, so this request no longer applies. The run panel shows the latest draft.',
          )}
        </p>
      )}
      {outcome === 'declined' && (
        <p className="text-muted-foreground">
          {t(
            'factory.specRequest.declinedNote',
            'Nothing was approved. The run still waits on its spec.',
          )}
        </p>
      )}
      {outcome === 'approved' && <RunNow request={request} run={run} />}
    </div>
  );
}

/** After an approval: where the run is now (it waits in the queue for a slot). */
function RunNow({ request, run }: { request: FactoryApprovalRequest; run: FactoryRun }) {
  const { t } = useTranslation();
  const state = factoryRunStateChip(t, run);
  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid={`factory-spec-request-run-now-${request.id}`}
    >
      <span>{t('factory.approvalRequest.runNow', 'The run now:')}</span>
      <LabelBadge tone={state.tone}>{state.label}</LabelBadge>
    </div>
  );
}
