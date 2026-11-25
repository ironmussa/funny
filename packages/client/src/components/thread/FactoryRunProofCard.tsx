/**
 * The regression proof of a factory run's pull request, as a card in the run's
 * thread at the time it ran (change factory-quality-gates): the verdict, why, the
 * test files and commands that ran, and the output kept as evidence (on a
 * pass, the base's failing output; on a fail, the failing run's).
 */
import { ChevronRight, ShieldCheck, ShieldMinus, ShieldX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useFactoryRunForThread } from '@/data/factory/hooks';
import type { FactoryRegressionProof } from '@/lib/api/factory';
import { useThreadById } from '@/lib/thread-selectors';
import { isFactoryThread } from '@/lib/thread-variant';
import { cn } from '@/lib/utils';

export function FactoryRunProofCard({ threadId }: { threadId?: string }) {
  const thread = useThreadById(threadId);
  if (!threadId || !thread?.projectId || !isFactoryThread(thread)) return null;
  return <FactoryRunProof projectId={thread.projectId} threadId={threadId} />;
}

/** The proof card of the run that started `threadId` in `projectId`, once a proof ran. */
export function FactoryRunProof({ projectId, threadId }: { projectId: string; threadId: string }) {
  const run = useFactoryRunForThread(projectId, threadId);
  if (!run?.regressionProof) return null;
  return <RegressionProofDetails proof={run.regressionProof} />;
}

const VERDICT_STYLE = {
  pass: { Icon: ShieldCheck, tone: 'text-status-success', badge: 'secondary' },
  fail: { Icon: ShieldX, tone: 'text-destructive', badge: 'destructive' },
  skipped: { Icon: ShieldMinus, tone: 'text-muted-foreground', badge: 'outline' },
} as const;

/** One proof, shown in the run's thread. */
export function RegressionProofDetails({ proof }: { proof: FactoryRegressionProof }) {
  const { t } = useTranslation();
  const style = VERDICT_STYLE[proof.verdict];
  const verdict = {
    pass: t('factory.proof.pass', 'Passed'),
    fail: t('factory.proof.fail', 'Failed'),
    skipped: t('factory.proof.skipped', 'Skipped'),
  }[proof.verdict];

  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border px-3 py-2 text-xs',
        proof.verdict === 'fail' ? 'border-destructive/40 bg-destructive/5' : 'bg-card',
      )}
      data-testid="factory-run-proof-card"
    >
      <div className="flex items-center gap-2">
        <style.Icon className={cn('icon-sm shrink-0', style.tone)} />
        <span className="font-medium">{t('factory.proof.title', 'Regression proof')}</span>
        <Badge size="xs" variant={style.badge} data-testid="factory-run-proof-verdict">
          {verdict}
        </Badge>
        <span className="text-muted-foreground ml-auto font-mono" title={proof.headSha}>
          {proof.headSha.slice(0, 7)}
        </span>
      </div>

      {proof.verdict === 'pass' && (
        <p className="text-muted-foreground" data-testid="factory-run-proof-summary">
          {t(
            'factory.proof.passSummary',
            'The changed tests pass on this commit and fail without the fix.',
          )}
        </p>
      )}
      {proof.finding && (
        <p
          className="text-foreground break-words whitespace-pre-wrap"
          data-testid="factory-run-proof-finding"
        >
          {proof.finding}
        </p>
      )}

      <ProofFiles files={proof.files ?? []} />
      <ProofEvidence proof={proof} />
    </div>
  );
}

/** The changed test files the proof ran. */
function ProofFiles({ files }: { files: string[] }) {
  const { t } = useTranslation();
  if (files.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <span className="text-muted-foreground">{t('factory.proof.files', 'Tests')}</span>
      <ul className="space-y-0.5" data-testid="factory-run-proof-files">
        {files.map((file) => (
          <li key={file} className="truncate font-mono" title={file}>
            {file}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The commands the proof ran and the end of their output, folded. */
function ProofEvidence({ proof }: { proof: FactoryRegressionProof }) {
  const { t } = useTranslation();
  const commands = proof.commands ?? [];
  if (commands.length === 0 && !proof.outputTail) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group text-muted-foreground hover:text-foreground flex items-center gap-1"
          data-testid="factory-run-proof-details-toggle"
        >
          <ChevronRight className="icon-xs transition-transform group-data-[state=open]:rotate-90" />
          {proof.verdict === 'pass'
            ? t('factory.proof.evidence', 'Commands and the failure without the fix')
            : t('factory.proof.details', 'Commands and output')}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent asChild>
        <div className="mt-1 space-y-1">
          {commands.map((command) => (
            <pre
              key={command}
              className="bg-muted overflow-x-auto rounded px-2 py-1 font-mono text-[length:var(--code-font-size)]"
              data-testid="factory-run-proof-command"
            >
              {command}
            </pre>
          ))}
          {proof.outputTail && (
            <pre
              className="bg-muted max-h-64 overflow-auto rounded px-2 py-1 font-mono text-[length:var(--code-font-size)] whitespace-pre-wrap"
              data-testid="factory-run-proof-output"
            >
              {proof.outputTail}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
