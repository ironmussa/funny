import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  confirmFactoryFlowSetup,
  discardFactoryFlowSetup,
  openFactoryFlowSetupPR,
} from '@/data/factory/actions';
import { useFactoryFlowSetup } from '@/data/factory/hooks';
import type {
  FactoryFlowSetupRuleCheckRun,
  FactoryFlowSetupRuleVerdict,
  FactoryFlowSetupView,
} from '@/lib/api/factory';
import { toastError } from '@/lib/toast-error';

interface ProjectFactoryFlowSetupCardProps {
  projectId: string;
  flowName: string;
}

function simpleLineDiff(
  before: string,
  after: string,
): Array<{ kind: 'same' | 'add' | 'del'; line: string }> {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const out: Array<{ kind: 'same' | 'add' | 'del'; line: string }> = [];

  for (const line of oldLines) {
    if (!newSet.has(line)) out.push({ kind: 'del', line });
  }
  for (const line of newLines) {
    out.push({ kind: oldSet.has(line) ? 'same' : 'add', line });
  }
  return out;
}

function CheckRunRow({ label, run }: { label: string; run?: FactoryFlowSetupRuleCheckRun }) {
  if (!run) return null;
  return (
    <div className="border-border/60 bg-muted/30 space-y-1 rounded border p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground font-mono">
          exit {run.exitCode ?? 'null'}
          {run.timedOut ? ' (timeout)' : ''}
        </span>
      </div>
      <div className="text-compact text-muted-foreground font-mono">{run.command}</div>
      {run.output && (
        <pre className="bg-background text-compact max-h-28 overflow-auto rounded p-1.5 font-mono whitespace-pre-wrap">
          {run.output}
        </pre>
      )}
    </div>
  );
}

function RuleVerdictSection({ rules }: { rules: FactoryFlowSetupRuleVerdict[] }) {
  const { t } = useTranslation();
  if (rules.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="factory-setup-verdicts">
      <div className="text-muted-foreground text-xs font-medium">
        {t('settings.factorySetupVerificationResults', 'Verification results')}
      </div>
      {rules.map((rule) => (
        <div
          key={rule.ruleIndex}
          className="border-border space-y-2 rounded-md border p-3"
          data-testid={`factory-setup-rule-${rule.ruleIndex}`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="font-mono text-xs">{rule.globs.join(', ')}</div>
            <Badge variant={rule.accepted ? 'default' : 'destructive'}>
              {rule.accepted
                ? t('settings.factorySetupRuleAccepted', 'Accepted')
                : t('settings.factorySetupRuleRejected', 'Rejected')}
            </Badge>
          </div>
          <div className="text-muted-foreground font-mono text-xs">{rule.command}</div>
          {rule.rejectionReason && (
            <div className="text-destructive text-xs">{rule.rejectionReason}</div>
          )}
          <div className="grid gap-1.5">
            <CheckRunRow
              label={t('settings.factorySetupPassingCanary', 'Passing canary')}
              run={rule.passingCanary}
            />
            <CheckRunRow
              label={t('settings.factorySetupFailingCanary', 'Failing canary')}
              run={rule.failingCanary}
            />
            <CheckRunRow
              label={t('settings.factorySetupExistingTest', 'Existing repository test')}
              run={rule.existingTest}
            />
            <CheckRunRow
              label={t('settings.factorySetupTwoFileRun', 'Two-file run')}
              run={rule.twoFileRun}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

interface SetupActions {
  busy: boolean;
  confirm: (variant: 'rules' | 'opt-out') => void;
  openPr: () => void;
  discard: () => void;
}

interface SetupStateProps {
  setup: FactoryFlowSetupView;
  projectId: string;
  actions: SetupActions;
}

function SetupThreadLink({ setup, projectId }: Omit<SetupStateProps, 'actions'>) {
  const { t } = useTranslation();
  if (!setup.threadId) return null;
  return (
    <a
      href={`/projects/${projectId}/threads/${setup.threadId}`}
      className="text-primary text-xs font-medium underline"
      data-testid="factory-setup-thread-link"
    >
      {t('settings.factorySetupOpenThread', 'Open setup thread')}
    </a>
  );
}

/** Generating on the runner, or verifying in a clean checkout: say so and link the thread. */
function InProgressState({ setup, projectId }: Omit<SetupStateProps, 'actions'>) {
  const { t } = useTranslation();
  const generating = setup.state === 'generating';
  return (
    <div
      className="space-y-2"
      data-testid={generating ? 'factory-setup-generating' : 'factory-setup-verifying'}
    >
      <p className="text-muted-foreground">
        {generating
          ? t(
              'settings.factorySetupGenerating',
              'Generating regression proof rules on your runner…',
            )
          : t(
              'settings.factorySetupVerifying',
              'Verifying generated rules in a clean checkout of {{branch}}…',
              { branch: setup.defaultBranch },
            )}
      </p>
      <SetupThreadLink setup={setup} projectId={projectId} />
    </div>
  );
}

function FailedState({ setup, actions }: SetupStateProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid="factory-setup-failed">
      {setup.error && (
        <Alert variant="destructive" data-testid="factory-setup-error">
          <AlertDescription>{setup.error}</AlertDescription>
        </Alert>
      )}
      {setup.verdicts && <RuleVerdictSection rules={setup.verdicts.rules} />}
      <div className="border-border space-y-1.5 border-t pt-3">
        <p className="text-muted-foreground text-xs">
          {t(
            'settings.factorySetupOptOutNote',
            'Or opt out explicitly: runs will merge without showing their test catches the bug.',
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actions.busy}
          data-testid="factory-setup-opt-out"
          onClick={() => actions.confirm('opt-out')}
        >
          {t('settings.factorySetupOptOut', 'Merge without regression proof')}
        </Button>
      </div>
    </div>
  );
}

function DiscardButton({ actions }: { actions: SetupActions }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={actions.busy}
      data-testid="factory-setup-discard"
      onClick={actions.discard}
    >
      {t('settings.factorySetupDiscard', 'Discard')}
    </Button>
  );
}

function PushRejectedState({ setup, actions }: SetupStateProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid="factory-setup-push-rejected">
      <Alert variant="destructive" data-testid="factory-setup-push-rejected-reason">
        <AlertDescription>
          {setup.error ??
            t(
              'settings.factorySetupPushRejectedFallback',
              'Push to {{branch}} was rejected by branch rules.',
              { branch: setup.defaultBranch },
            )}
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={actions.busy}
          data-testid="factory-setup-open-pr"
          onClick={actions.openPr}
        >
          {t('settings.factorySetupOpenPr', 'Open a pull request')}
        </Button>
        <DiscardButton actions={actions} />
      </div>
    </div>
  );
}

function PrOpenState({ setup, actions }: SetupStateProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2" data-testid="factory-setup-pr-open">
      <p className="text-muted-foreground">
        {t(
          'settings.factorySetupPrOpen',
          'Pull request opened against {{branch}}. The factory can be enabled once it merges.',
          { branch: setup.defaultBranch },
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {setup.prUrl && (
          <a
            href={setup.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary text-xs font-medium underline"
            data-testid="factory-setup-pr-link"
          >
            {setup.prNumber
              ? t('settings.factorySetupViewPrNumber', 'View pull request #{{number}}', {
                  number: setup.prNumber,
                })
              : t('settings.factorySetupViewPr', 'View pull request')}
          </a>
        )}
        <DiscardButton actions={actions} />
      </div>
    </div>
  );
}

function CommittedState({ setup }: Omit<SetupStateProps, 'actions'>) {
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground text-xs" data-testid="factory-setup-committed">
      {t('settings.factorySetupCommitted', 'Committed to {{branch}}', {
        branch: setup.defaultBranch,
      })}
      {setup.commitSha ? ` (${setup.commitSha.slice(0, 7)})` : ''}.
    </div>
  );
}

/** What the card shows for the setup's state. */
function SetupStateBody(props: SetupStateProps) {
  const { t } = useTranslation();
  const { setup, actions } = props;
  switch (setup.state) {
    case 'generating':
    case 'verifying':
      return <InProgressState setup={setup} projectId={props.projectId} />;
    case 'committing':
      return (
        <p className="text-muted-foreground" data-testid="factory-setup-committing">
          {t('settings.factorySetupCommitting', 'Committing and pushing to {{branch}}…', {
            branch: setup.defaultBranch,
          })}
        </p>
      );
    case 'proposed':
      return (
        <ProposedContent
          setup={setup}
          busy={actions.busy}
          onConfirm={actions.confirm}
          onDiscard={actions.discard}
        />
      );
    case 'failed':
      return <FailedState {...props} />;
    case 'push_rejected':
      return <PushRejectedState {...props} />;
    case 'pr_open':
      return <PrOpenState {...props} />;
    case 'committed':
      return <CommittedState setup={setup} projectId={props.projectId} />;
    default:
      return null;
  }
}

export function ProjectFactoryFlowSetupCard({
  projectId,
  flowName,
}: ProjectFactoryFlowSetupCardProps) {
  const { t } = useTranslation();
  const setup = useFactoryFlowSetup(projectId, flowName);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!setup || setup.state === 'discarded') return null;

  async function runAction(fn: () => ResultAsync<FactoryFlowSetupView, DomainError>) {
    setBusy(true);
    setActionError(null);
    const result = await fn();
    setBusy(false);
    if (result.isErr()) {
      setActionError(result.error.message);
      toastError(result.error);
    }
  }

  const actions: SetupActions = {
    busy,
    confirm: (variant) =>
      void runAction(() =>
        confirmFactoryFlowSetup(projectId, setup.id, setup.proposedFileSha ?? '', variant),
      ),
    openPr: () => void runAction(() => openFactoryFlowSetupPR(projectId, setup.id)),
    discard: () => void runAction(() => discardFactoryFlowSetup(projectId, setup.id)),
  };

  return (
    <div
      className="border-border bg-card mx-4 my-3 space-y-3 rounded-lg border p-4 text-sm"
      data-testid="factory-setup-card"
      data-setup-state={setup.state}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">
          {t('settings.factorySetupTitle', 'Regression proof setup ({{flow}})', {
            flow: setup.flowName,
          })}
        </div>
        <Badge variant="outline">{setup.state}</Badge>
      </div>

      {actionError && (
        <Alert variant="destructive" data-testid="factory-setup-action-error">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <SetupStateBody setup={setup} projectId={projectId} actions={actions} />
    </div>
  );
}

const DIFF_LINE_CLASS: Record<'same' | 'add' | 'del', string> = {
  add: 'text-diff-added',
  del: 'text-destructive line-through',
  same: 'text-foreground',
};

const DIFF_LINE_PREFIX: Record<'same' | 'add' | 'del', string> = {
  add: '+ ',
  del: '- ',
  same: '  ',
};

function ProposedContent({
  setup,
  busy,
  onConfirm,
  onDiscard,
}: {
  setup: FactoryFlowSetupView;
  busy: boolean;
  onConfirm: (variant: 'rules' | 'opt-out') => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const diffLines = setup.proposedFile
    ? simpleLineDiff(setup.startingFile, setup.proposedFile)
    : [];

  return (
    <div className="space-y-3" data-testid="factory-setup-proposed">
      {setup.facts && (
        <div className="space-y-1" data-testid="factory-setup-facts">
          <div className="text-muted-foreground text-xs font-medium">
            {t('settings.factorySetupDetectedStack', 'Detected stack')}
          </div>
          <div className="text-xs">
            {setup.facts.recognized
              ? [
                  setup.facts.packageManager
                    ? `Package manager: ${setup.facts.packageManager}`
                    : null,
                  setup.facts.packages?.length
                    ? `Packages: ${setup.facts.packages.map((p) => `${p.name} (${p.runner})`).join(', ')}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : t('settings.factorySetupStackUnrecognized', 'No test runner recognized')}
          </div>
        </div>
      )}

      {setup.proposedFile && (
        <div className="space-y-1" data-testid="factory-setup-diff">
          <div className="text-muted-foreground text-xs font-medium">
            {t('settings.factorySetupProposedFile', 'Proposed .funny/workflows/{{flow}}.yaml', {
              flow: setup.flowName,
            })}
          </div>
          <pre className="border-border bg-muted/30 text-compact max-h-56 overflow-auto rounded border p-2 font-mono">
            {diffLines.map((entry, idx) => (
              <div key={idx} className={DIFF_LINE_CLASS[entry.kind]}>
                {DIFF_LINE_PREFIX[entry.kind]}
                {entry.line}
              </div>
            ))}
          </pre>
        </div>
      )}

      {setup.verdicts && <RuleVerdictSection rules={setup.verdicts.rules} />}

      {setup.verdicts && setup.verdicts.uncovered.length > 0 && (
        <div className="space-y-1" data-testid="factory-setup-uncovered">
          <div className="text-muted-foreground text-xs font-medium">
            {t('settings.factorySetupUncovered', 'Left uncovered')}
          </div>
          <ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-xs">
            {setup.verdicts.uncovered.map((item, idx) => (
              <li key={idx}>
                <span className="text-foreground font-mono">{item.scope}</span>: {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-border space-y-2 border-t pt-3">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            data-testid="factory-setup-commit"
            onClick={() => onConfirm('rules')}
          >
            {t('settings.factorySetupCommitPush', 'Commit and push to {{branch}}', {
              branch: setup.defaultBranch,
            })}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            data-testid="factory-setup-opt-out"
            onClick={() => onConfirm('opt-out')}
          >
            {t('settings.factorySetupOptOut', 'Merge without regression proof')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            data-testid="factory-setup-discard"
            onClick={onDiscard}
          >
            {t('settings.factorySetupDiscard', 'Discard')}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          {t(
            'settings.factorySetupOptOutNote',
            'Or opt out explicitly: runs will merge without showing their test catches the bug.',
          )}
        </p>
      </div>
    </div>
  );
}
