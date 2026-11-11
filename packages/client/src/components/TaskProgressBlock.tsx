import type { TaskIssue, TaskProgress, TaskStep } from '@funny/shared/task-progress';
import { AlertTriangle, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  formatDuration,
  ProgressFileFallback,
  runElapsed,
  StatusIcon,
  TONE,
  useNow,
  type TFunction,
} from '@/components/progress/progress-parts';
import { Progress } from '@/components/ui/progress';
import { useTaskProgress } from '@/hooks/use-task-progress';
import { summarizeTaskProgress } from '@/lib/task-progress-summary';
import { cn } from '@/lib/utils';

/** Issues listed before the rest collapse into "showing the first N". */
const ISSUES_SHOWN = 15;

function IssueCounts({ errors, warnings }: { errors: number; warnings: number }) {
  return (
    <>
      {errors > 0 && <span className={TONE.failed}>✗ {errors}</span>}
      {warnings > 0 && <span className={TONE.skipped}>⚠ {warnings}</span>}
    </>
  );
}

function StepRow({ step, now, t }: { step: TaskStep; now: number; t: TFunction }) {
  const elapsed =
    step.durationMs ?? (step.startedAt !== undefined ? now - step.startedAt : undefined);
  const showUnits = step.unitsTotal !== undefined && step.status === 'running';
  return (
    <li
      data-testid={`task-progress-step-${step.name}`}
      data-status={step.status}
      className="flex min-w-0 flex-col gap-0.5 py-1"
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon status={step.status} />
        <span className="truncate font-medium" title={step.id}>
          {step.name}
        </span>
        <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2 tabular-nums">
          {showUnits && (
            <span data-testid={`task-progress-units-${step.name}`}>
              {t('taskProgress.units', { done: step.unitsDone ?? 0, total: step.unitsTotal })}
            </span>
          )}
          <IssueCounts errors={step.errors} warnings={step.warnings} />
          {elapsed !== undefined && <span>{formatDuration(elapsed, t)}</span>}
        </span>
      </div>
      {step.status === 'running' && step.current && (
        <span className="text-muted-foreground truncate pl-5 font-mono" title={step.current}>
          {step.current}
        </span>
      )}
      {step.status === 'failed' && step.tail.length > 0 && (
        <pre
          className="bg-muted/40 text-muted-foreground ml-5 overflow-x-auto rounded px-2 py-1 font-mono whitespace-pre-wrap"
          data-testid={`task-progress-tail-${step.name}`}
          aria-label={t('taskProgress.output')}
        >
          {step.tail.join('\n')}
        </pre>
      )}
    </li>
  );
}

function issueLocation(issue: TaskIssue): string | undefined {
  if (!issue.file) return undefined;
  return issue.line
    ? `${issue.file}:${issue.line}${issue.column ? `:${issue.column}` : ''}`
    : issue.file;
}

function IssueList({ issues, total, t }: { issues: TaskIssue[]; total: number; t: TFunction }) {
  const shown = issues.slice(0, ISSUES_SHOWN);
  return (
    <div className="flex flex-col gap-1" data-testid="task-progress-issues">
      <span className="text-muted-foreground font-medium">{t('taskProgress.issues')}</span>
      <ul className="flex flex-col gap-0.5">
        {shown.map((issue, index) => {
          const Icon = issue.severity === 'error' ? XCircle : AlertTriangle;
          const location = issueLocation(issue);
          return (
            <li key={index} className="flex min-w-0 items-start gap-2">
              <Icon
                className={cn(
                  'mt-0.5 size-3.5 shrink-0',
                  issue.severity === 'error' ? TONE.failed : TONE.skipped,
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                {location && <span className="font-mono">{location} </span>}
                <span className="text-muted-foreground">{issue.message}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {total > shown.length && (
        <span className="text-muted-foreground">
          {t('taskProgress.moreIssues', { shown: shown.length, total })}
        </span>
      )}
    </div>
  );
}

function TaskProgressView({ progress }: { progress: TaskProgress }) {
  const { t } = useTranslation();
  const running = progress.status === 'running';
  const now = useNow(running);
  const summary = summarizeTaskProgress(progress);

  return (
    <div
      data-testid="task-progress"
      data-status={progress.status}
      className="bg-card text-card-foreground flex flex-col gap-2 rounded-md border p-3 text-sm"
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={progress.status} className="size-4" />
        <span className="font-medium">
          {t(`taskProgress.status.${progress.status}`, { title: progress.title })}
        </span>
        {running && progress.concurrency && (
          <span className="text-muted-foreground tabular-nums" data-testid="task-progress-running">
            {t('taskProgress.running', {
              count: summary.stepsRunning,
              max: progress.concurrency,
            })}
          </span>
        )}
        <span
          className="text-muted-foreground ml-auto tabular-nums"
          data-testid="task-progress-elapsed"
        >
          {formatDuration(runElapsed(progress, now), t)}
        </span>
      </div>

      <Progress value={summary.percent} className="h-1.5" data-testid="task-progress-bar" />

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
        <span data-testid="task-progress-steps">
          {t('taskProgress.steps', { done: summary.stepsDone, total: progress.steps.length })}
        </span>
        <span>{Math.floor(summary.percent)}%</span>
        {summary.errors > 0 && (
          <span className={TONE.failed} data-testid="task-progress-errors">
            {t('taskProgress.errors', { count: summary.errors })}
          </span>
        )}
        {summary.warnings > 0 && (
          <span className={TONE.skipped} data-testid="task-progress-warnings">
            {t('taskProgress.warnings', { count: summary.warnings })}
          </span>
        )}
      </div>

      <ul className="divide-border/60 divide-y">
        {progress.steps.map((step) => (
          <StepRow key={step.id} step={step} now={now} t={t} />
        ))}
      </ul>

      {progress.issues.length > 0 && (
        <IssueList issues={progress.issues} total={summary.errors + summary.warnings} t={t} />
      )}
    </div>
  );
}

/** Follows the task progress file at `path` and renders it. */
export function TaskProgressBlock({ path }: { path: string | null }) {
  const state = useTaskProgress(path);
  if (state.kind === 'ready') return <TaskProgressView progress={state.progress} />;
  return <ProgressFileFallback kind={state.kind} path={path} testIdPrefix="task-progress" />;
}
