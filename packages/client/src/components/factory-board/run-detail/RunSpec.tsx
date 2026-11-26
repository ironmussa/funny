/**
 * The Spec section of a run's detail panel (openspec factory-spec-stage): the
 * spec writer's open questions with a link to its thread, or its draft with
 * Approve, or the approved spec with who approved it and when. The draft is
 * agent output: it is rendered as plain text, never as Markdown or HTML.
 */
import type { FactorySpec } from '@funny/shared/contracts/factory';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { LabelBadge } from '@/components/ui/label-badge';
import { approveFactorySpec, reopenFactorySpec } from '@/data/factory/actions';
import { useCanSteerProject } from '@/data/projects/hooks';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { getThreadRoute } from '@/lib/thread-variant';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { useAuthStore } from '@/stores/auth-store';

import { DetailSection } from './sections';

/** States from which a member may reopen an approved spec (the server decides again). */
const REOPENABLE = new Set<FactoryQueueRun['state']>([
  'requested',
  'waiting_human',
  'failed',
  'no_change',
  'stopped',
]);

/** Whether the run has a spec section to show. */
export const hasFactoryRunSpec = (run: Pick<FactoryQueueRun, 'spec'>): boolean => Boolean(run.spec);

function SpecList({ title, items, testId }: { title: string; items: string[]; testId: string }) {
  if (items.length === 0) return null;
  return (
    <>
      <p>{title}</p>
      <ul className="text-foreground list-disc pl-4" data-testid={testId}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

/** A spec draft (or the approved spec), section by section. */
export function SpecBody({ spec }: { spec: FactorySpec }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5" data-testid="factory-spec-body">
      <p className="text-foreground whitespace-pre-wrap">{spec.summary}</p>
      <SpecList
        title={t('factorySpec.decisions', 'Decisions')}
        items={spec.decisions.map((decision) => `${decision.question} — ${decision.answer}`)}
        testId="factory-spec-decisions"
      />
      <SpecList
        title={t('factorySpec.behavior', 'Behavior')}
        items={spec.behavior}
        testId="factory-spec-behavior"
      />
      <SpecList
        title={t('factorySpec.approach', 'Approach')}
        items={spec.approach}
        testId="factory-spec-approach"
      />
      <SpecList
        title={t('factorySpec.outOfScope', 'Out of scope')}
        items={spec.outOfScope}
        testId="factory-spec-out-of-scope"
      />
      <SpecList
        title={t('factorySpec.validation', 'Validation checklist')}
        items={spec.validation}
        testId="factory-spec-validation"
      />
    </div>
  );
}

function SpecQuestionsSection({
  questions,
}: {
  questions: Array<{ question: string; options: string[] }>;
}) {
  const { t } = useTranslation();
  if (questions.length === 0) return null;
  return (
    <>
      <p>
        {t('factorySpec.questionsIntro', 'The spec writer asks the team. Answer in its thread:')}
      </p>
      <ul className="text-foreground list-disc pl-4" data-testid="factory-spec-questions">
        {questions.map((question) => (
          <li key={question.question}>
            {question.question}
            {question.options.length > 0 && (
              <span className="text-muted-foreground"> ({question.options.join(' / ')})</span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function SpecDraftSection({
  draft,
  revision,
  canSteer,
  busy,
  onApprove,
}: {
  draft: FactorySpec;
  revision: number;
  canSteer: boolean;
  busy: boolean;
  onApprove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <LabelBadge tone="warning">
        {t('factorySpec.draftBadge', 'Draft {{revision}} waits for approval', { revision })}
      </LabelBadge>
      <SpecBody spec={draft} />
      {canSteer && (
        <div className="flex gap-1.5 pt-1">
          <Button size="xs" disabled={busy} onClick={onApprove} data-testid="factory-spec-approve">
            {t('factorySpec.approve', 'Approve spec')}
          </Button>
        </div>
      )}
    </>
  );
}

function SpecApprovedSection({
  approved,
  currentUserId,
  canReopen,
  busy,
  onReopen,
}: {
  approved: NonNullable<NonNullable<FactoryQueueRun['spec']>['approved']>;
  currentUserId: string | undefined;
  canReopen: boolean;
  busy: boolean;
  onReopen: () => void;
}) {
  const { t } = useTranslation();
  const at = new Date(approved.at).toLocaleString();
  return (
    <>
      <p data-testid="factory-spec-approved">
        {approved.by === currentUserId
          ? t('factorySpec.approvedByYou', 'Approved by you, {{at}}', { at })
          : t('factorySpec.approvedByMember', 'Approved by a member, {{at}}', { at })}
      </p>
      <SpecBody spec={approved.spec} />
      {canReopen && (
        <div className="flex gap-1.5 pt-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={onReopen}
            data-testid="factory-spec-reopen"
          >
            {t('factorySpec.reopen', 'Reopen spec')}
          </Button>
        </div>
      )}
    </>
  );
}

function SpecThreadLink({ projectId, threadId }: { projectId: string; threadId: string }) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  return (
    <Button
      size="xs"
      variant="link"
      onClick={() =>
        navigate(buildPath(getThreadRoute({ id: threadId, projectId, isScratch: false })))
      }
      data-testid="factory-spec-thread-link"
    >
      {t('factorySpec.thread', 'Spec thread')}
      <ExternalLink className="icon-xs" />
    </Button>
  );
}

function SpecWaitingStatus({ hasProblem, hasLatest }: { hasProblem: boolean; hasLatest: boolean }) {
  const { t } = useTranslation();
  if (hasProblem) {
    return (
      <p data-testid="factory-spec-problem">
        {t(
          'factorySpec.problem',
          'The spec writer gave no valid spec. Answer it in its thread, or retry the run to triage it again.',
        )}
      </p>
    );
  }
  if (!hasLatest) {
    return <p>{t('factorySpec.writing', 'The spec writer is reading the issue and the code.')}</p>;
  }
  return null;
}

export function RunSpec({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const canSteer = useCanSteerProject(run.projectId);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [busy, setBusy] = useState(false);
  const spec = run.spec;
  if (!spec) return null;
  const latest = spec.latest;
  const waiting = run.state === 'needs_spec';
  const draft = waiting && latest?.status === 'draft' ? latest.spec : null;
  const questions = waiting && latest?.status === 'questions' ? latest.questions : [];
  const approved = spec.approved;

  const approve = () => {
    setBusy(true);
    void approveFactorySpec(run.projectId, run.id, spec.revision)
      // A refusal reads the runs again: the newer draft replaces this one on screen.
      .orTee((error) => toastError(error, 'factoryApproveSpec'))
      .match(
        () => setBusy(false),
        () => setBusy(false),
      );
  };
  const reopen = () => {
    setBusy(true);
    void reopenFactorySpec(run.projectId, run.id)
      .orTee((error) => toastError(error, 'factoryReopenSpec'))
      .match(
        () => setBusy(false),
        () => setBusy(false),
      );
  };

  const threadLink = spec.threadId ? (
    <SpecThreadLink projectId={run.projectId} threadId={spec.threadId} />
  ) : null;

  return (
    <DetailSection id="spec" title={t('factorySpec.title', 'Spec')} aside={threadLink}>
      {waiting && (
        <SpecWaitingStatus hasProblem={Boolean(spec.problem)} hasLatest={Boolean(latest)} />
      )}
      <SpecQuestionsSection questions={questions} />
      {draft && (
        <SpecDraftSection
          draft={draft}
          revision={spec.revision}
          canSteer={canSteer}
          busy={busy}
          onApprove={approve}
        />
      )}
      {approved && !waiting && (
        <SpecApprovedSection
          approved={approved}
          currentUserId={currentUserId}
          canReopen={canSteer && REOPENABLE.has(run.state)}
          busy={busy}
          onReopen={reopen}
        />
      )}
    </DetailSection>
  );
}
