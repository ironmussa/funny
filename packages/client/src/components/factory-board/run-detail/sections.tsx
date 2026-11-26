/**
 * The sections of a run's detail panel (openspec factory-run-detail, D3), in
 * pipeline order. Each one shows only what the run has reached.
 */
import {
  lintCleanupSource,
  type FactoryMergeApproval,
  type FactoryReviewVerdict,
  type FactoryTriage,
  displayRiskReason,
} from '@funny/shared/contracts/factory';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { LabelBadge } from '@/components/ui/label-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { factoryReviewPassed, isFactoryRunAwaitingMergeApproval } from '@/lib/factory-run-labels';
import { useThreadById } from '@/lib/thread-selectors';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';

import { ApprovalGapNote } from '../ApprovalGapNote';
import { type FactoryRunThreadRole, factoryRunThreadLinks } from './thread-links';

const short = (sha: string) => sha.slice(0, 7);

export function DetailSection({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5" data-testid={`factory-run-detail-${id}`}>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {aside && <div className="ml-auto flex items-center gap-1">{aside}</div>}
      </div>
      <div className="text-muted-foreground flex flex-col gap-1 text-xs">{children}</div>
    </section>
  );
}

/** A button that opens one of the run's threads. */
function ThreadLink({
  projectId,
  threadId,
  label,
  testId,
}: {
  projectId: string;
  threadId: string | undefined;
  label: string;
  testId: string;
}) {
  const navigate = useStableNavigate();
  if (!threadId) return null;
  return (
    <Button
      size="xs"
      variant="link"
      onClick={() =>
        navigate(buildPath(getThreadRoute({ id: threadId, projectId, isScratch: false })))
      }
      data-testid={testId}
    >
      {label}
      <ExternalLink className="icon-xs" />
    </Button>
  );
}

function TriageItems({ triage }: { triage: FactoryTriage }) {
  const { t } = useTranslation();
  if (triage.decision === 'none') {
    return (
      <p>
        {t(
          'factoryRunDetail.triage.none',
          'Triage gave no contract: the review judges against the issue.',
        )}
      </p>
    );
  }
  const items =
    triage.decision === 'ready'
      ? (triage.contract?.acceptanceCriteria ?? [])
      : (triage.items ?? []);
  const heading = {
    ready: t('factoryRunDetail.triage.ready', 'Contract: what must be true'),
    needs_info: t('factoryRunDetail.triage.needsInfo', 'Asked on the issue'),
    too_big: t('factoryRunDetail.triage.tooBig', 'Proposed split'),
  }[triage.decision];
  return (
    <>
      <p>{heading}</p>
      <ul className="text-foreground list-disc pl-4" data-testid="factory-run-detail-triage-items">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

export function RunTriage({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const triage = run.triage;
  if (!triage) return null;
  return (
    <DetailSection
      id="triage"
      title={t('factoryRunDetail.triage.title', 'Triage')}
      aside={
        <>
          {triage.superseded && (
            <LabelBadge tone="neutral">{t('factoryRunDetail.superseded', 'Superseded')}</LabelBadge>
          )}
          <ThreadLink
            projectId={run.projectId}
            threadId={triage.threadId}
            label={t('factoryRunDetail.thread', 'Thread')}
            testId="factory-run-detail-triage-thread"
          />
        </>
      }
    >
      <TriageItems triage={triage} />
    </DetailSection>
  );
}

function ReviewEntry({
  review,
  projectId,
  index,
}: {
  review: FactoryReviewVerdict;
  projectId: string;
  index: number;
}) {
  const { t } = useTranslation();
  const passed = factoryReviewPassed(review);
  const findings = review.findings.toSorted(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  return (
    <li
      className="flex flex-col gap-1 border-l pl-2"
      data-testid={`factory-run-detail-review-${index}`}
    >
      <div className="flex items-center gap-1.5">
        <LabelBadge tone={passed ? 'success' : 'danger'}>
          {passed
            ? t('factory.review.passed', 'Review passed')
            : t('factory.review.failed', 'Review failed')}
        </LabelBadge>
        <span className="font-mono">{short(review.sha)}</span>
        {review.carriedFrom && (
          <span>
            {t('factoryRunDetail.carriedFrom', 'from {{sha}}', { sha: short(review.carriedFrom) })}
          </span>
        )}
        <span className="ml-auto">
          <ThreadLink
            projectId={projectId}
            threadId={review.threadId}
            label={t('factoryRunDetail.thread', 'Thread')}
            testId={`factory-run-detail-review-thread-${index}`}
          />
        </span>
      </div>
      {review.summary && <p className="text-foreground">{review.summary}</p>}
      {findings.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {findings.map((finding, findingIndex) => (
            <li
              key={`${finding.title}-${findingIndex}`}
              className="flex flex-wrap items-baseline gap-1.5"
            >
              <LabelBadge tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</LabelBadge>
              <span className="text-foreground">{finding.title}</span>
              {finding.path && (
                <span className="font-mono">
                  {finding.path}
                  {finding.line ? `:${finding.line}` : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
const SEVERITY_TONE = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
} as const;

export function RunReviews({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  if (run.reviews.length === 0) return null;
  return (
    <DetailSection id="reviews" title={t('factoryRunDetail.reviews', 'Reviews')}>
      <ol className="flex flex-col gap-2">
        {run.reviews.map((review, index) => (
          <ReviewEntry
            key={`${review.sha}-${review.reviewedAt}`}
            review={review}
            projectId={run.projectId}
            index={index}
          />
        ))}
      </ol>
    </DetailSection>
  );
}

/**
 * A member's approval to merge the high-risk change: the commit they approved
 * and each commit the factory moved it to (openspec
 * factory-approval-survives-integration), so what merged on a moved approval
 * can be read afterwards.
 */
function RunMergeApproval({ approval }: { approval: FactoryMergeApproval }) {
  const { t } = useTranslation();
  const moves = approval.moves ?? [];
  return (
    <div className="flex flex-col gap-0.5" data-testid="factory-run-detail-approval">
      <p>
        {t('factoryRunDetail.approvedAt', 'Merge approved at')}{' '}
        <span className="font-mono">{short(approval.carriedFrom ?? approval.sha)}</span>
      </p>
      {moves.length > 0 && (
        <ul className="flex flex-col gap-0.5 border-l pl-2">
          {moves.map((move, index) => (
            <li key={move.to} data-testid={`factory-run-detail-approval-move-${index}`}>
              {t('factoryRunDetail.approvalMovedTo', 'moved to')}{' '}
              <span className="font-mono">{short(move.to)}</span>
              {' · '}
              {move.kind === 'same'
                ? t('factoryRunDetail.approvalSameChange', 'same change')
                : t(
                    'factoryRunDetail.approvalAdjustment',
                    '{{lines}} lines differ in {{files}} files',
                    { lines: move.lines, files: move.files.length },
                  )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RunRiskCi({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const { ciRounds, ciRed, conflicts, agentFixes } = run.metrics;
  if (!run.risk && !run.mergeApproval && ciRounds === 0) return null;
  return (
    <DetailSection id="risk-ci" title={t('factoryRunDetail.riskCi', 'Risk and CI')}>
      {isFactoryRunAwaitingMergeApproval(run) && (
        <ApprovalGapNote
          approval={run.mergeApproval}
          heldSha={run.risk?.headSha}
          prUrl={run.prUrl}
          testId="factory-run-detail-approval-gap"
        />
      )}
      {run.risk && (
        <p data-testid="factory-run-detail-risk">
          {run.risk.level === 'high'
            ? t('factoryRunDetail.riskHigh', 'High risk: {{reasons}}', {
                reasons: run.risk.reasons.map(displayRiskReason).join('; '),
              })
            : t('factoryRunDetail.riskLow', 'Low risk')}
        </p>
      )}
      {lintCleanupSource(run) !== null && (
        <div className="flex flex-col gap-0.5" data-testid="factory-run-detail-lint-cleanup">
          <p>
            {t(
              'factoryRunDetail.lintCleanupTriage',
              'Triage classed it as a lint cleanup of rules that cannot change behavior: its size and its contract risks do not hold it. You can say it is not one.',
            )}
          </p>
          {(run.risk?.waived ?? []).length > 0 && (
            <ul className="text-muted-foreground flex flex-col gap-0.5 border-l pl-2">
              {(run.risk?.waived ?? []).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {run.mergeApproval && <RunMergeApproval approval={run.mergeApproval} />}
      {ciRounds > 0 && (
        <p data-testid="factory-run-detail-ci">
          {t(
            'factoryRunDetail.ci',
            '{{rounds}} CI rounds · {{red}} red · {{conflicts}} conflicts · {{fixes}} agent fixes',
            {
              rounds: ciRounds,
              red: ciRed,
              conflicts,
              fixes: agentFixes,
            },
          )}
        </p>
      )}
    </DetailSection>
  );
}

function ThreadEntry({
  projectId,
  threadId,
  role,
  steps,
}: {
  projectId: string;
  threadId: string;
  role: FactoryRunThreadRole;
  steps: string[];
}) {
  const { t } = useTranslation();
  const thread = useThreadById(threadId);
  const roles: Record<FactoryRunThreadRole, string> = {
    triage: t('factoryRunDetail.role.triage', 'Triage'),
    implementer: t('factoryRunDetail.role.implementer', 'Implementer'),
    reviewer: t('factoryRunDetail.role.reviewer', 'Reviewer'),
    agent: t('factoryRunDetail.role.agent', 'Agent'),
  };
  return (
    <li className="flex min-w-0 items-center gap-1.5">
      <span className="text-foreground shrink-0">{roles[role]}</span>
      <span className="truncate font-mono">{steps.join(', ')}</span>
      {/* Every row reads the same; the thread's title is on hover, not in the row. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="ml-auto shrink-0">
            <ThreadLink
              projectId={projectId}
              threadId={threadId}
              label={t('factoryRunDetail.thread', 'Thread')}
              testId={`factory-run-detail-thread-${threadId}`}
            />
          </span>
        </TooltipTrigger>
        {thread?.title && <TooltipContent side="left">{thread.title}</TooltipContent>}
      </Tooltip>
    </li>
  );
}

export function RunThreads({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const links = factoryRunThreadLinks(run);
  if (links.length === 0) return null;
  return (
    <DetailSection id="threads" title={t('factoryRunDetail.threads', 'Agent threads')}>
      <ul className="flex flex-col gap-0.5">
        {links.map((link) => (
          <ThreadEntry key={link.threadId} projectId={run.projectId} {...link} />
        ))}
      </ul>
    </DetailSection>
  );
}
