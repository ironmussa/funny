/**
 * Which flow a factory run executed, from where, and what each of its agent
 * steps ran with (openspec factory-flow-step-options, D7): the source
 * (repository or built-in), the default-branch commit it was read at, and the
 * provider, model, effort and permission mode of every step.
 */
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { FactoryRun } from '@/lib/api/factory';
import { cn } from '@/lib/utils';

/** The repository a run's pull request is in (`owner/name`), or null without one. */
function repoOf(prUrl: string | null): string | null {
  const match = prUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  return match?.[1] ?? null;
}

/** Where the run's flow file is on GitHub at the commit it was read at, when that is known. */
export function flowFileUrl(run: FactoryRun): string | null {
  const repo = repoOf(run.prUrl);
  if (!repo || !run.flowCommit || !run.flowName) return null;
  return `https://github.com/${repo}/blob/${run.flowCommit}/.funny/workflows/${run.flowName}.yaml`;
}

export function ProjectFactoryRunFlow({ run }: { run: FactoryRun }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!run.flowSource && run.stepOptions.length === 0) return null;
  const url = flowFileUrl(run);
  const commit = run.flowCommit?.slice(0, 7);
  const sources = {
    repository: t('factory.flowSource.repository', 'repository'),
    'built-in': t('factory.flowSource.builtIn', 'built-in'),
  };
  const source = run.flowSource
    ? sources[run.flowSource]
    : t('factory.flowSource.unknown', 'source unknown');

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="pl-16 text-xs">
      <div className="text-muted-foreground flex items-center gap-1">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 text-left"
            data-testid={`factory-run-flow-toggle-${run.id}`}
          >
            <ChevronRight
              className={cn('icon-xs shrink-0 transition-transform', open && 'rotate-90')}
            />
            <span data-testid={`factory-run-flow-${run.id}`}>
              {run.flowName ?? t('factory.flowUnknown', 'flow')} · {source}
            </span>
          </button>
        </CollapsibleTrigger>
        {commit &&
          (url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline"
              data-testid={`factory-run-flow-commit-${run.id}`}
            >
              {commit}
            </a>
          ) : (
            <span className="font-mono" data-testid={`factory-run-flow-commit-${run.id}`}>
              {commit}
            </span>
          ))}
      </div>
      <CollapsibleContent>
        {open && (
          <ul className="py-1" data-testid={`factory-run-steps-${run.id}`}>
            {run.stepOptions.map((step, index) => (
              <li
                key={`${step.stepId}-${step.threadId}-${index}`}
                className="text-muted-foreground flex gap-2"
                data-testid={`factory-run-step-${run.id}-${step.stepId}`}
              >
                <span className="text-foreground min-w-[140px] font-mono">{step.stepId}</span>
                <span>
                  {[step.provider, step.model, step.effort, step.permissionMode]
                    .filter(Boolean)
                    .join(' · ')}
                  {step.thread === 'new' && ` · ${t('factory.ownThread', 'own thread')}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
