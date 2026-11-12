import type { TestFailure, TestProgress, TestProgressSuite } from '@funny/shared/test-progress';
import { Loader2, Timer, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
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
import { TestFileList } from '@/components/progress/TestFileList';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useTestProgress } from '@/hooks/use-test-progress';
import { summarizeTestProgress, type SlowItem } from '@/lib/test-progress-summary';
import { cn } from '@/lib/utils';

type T = TFunction;

/** Running files listed under a suite before the rest collapse into "+N more". */
const RUNNING_FILES_SHOWN = 3;
/** Failures listed before the rest collapse into "showing the first N". */
const FAILURES_SHOWN = 15;

/** Passed / failed / skipped counts, each only when non-zero. */
function Counts({ passed, failed, skipped }: { passed: number; failed: number; skipped: number }) {
  return (
    <>
      {passed > 0 && <span className={TONE.passed}>✓ {passed}</span>}
      {failed > 0 && <span className={TONE.failed}>✗ {failed}</span>}
      {skipped > 0 && <span className={TONE.skipped}>○ {skipped}</span>}
    </>
  );
}

/** What a running suite is doing: its files so far and the files running now. */
function SuiteActivity({ suite, now, t }: { suite: TestProgressSuite; now: number; t: T }) {
  const hidden = suite.running.length - RUNNING_FILES_SHOWN;
  return (
    <div className="flex flex-col gap-1 pl-5" data-testid={`test-progress-activity-${suite.name}`}>
      {suite.filesTotal !== undefined && (
        <div className="text-muted-foreground flex items-center gap-2 tabular-nums">
          <Progress
            value={((suite.filesDone ?? 0) / Math.max(suite.filesTotal, 1)) * 100}
            className="h-1 max-w-40"
          />
          <span data-testid={`test-progress-files-${suite.name}`}>
            {t('testProgress.files', { done: suite.filesDone ?? 0, total: suite.filesTotal })}
          </span>
        </div>
      )}
      {suite.running.slice(0, RUNNING_FILES_SHOWN).map((run) => (
        <div key={run.file} className="text-muted-foreground flex min-w-0 gap-2 font-mono">
          <span className="truncate" title={run.file}>
            {run.file}
          </span>
          <span className="ml-auto shrink-0 tabular-nums">
            {formatDuration(now - run.startedAt, t)}
          </span>
        </div>
      ))}
      {hidden > 0 && (
        <span className="text-muted-foreground">{t('testProgress.more', { count: hidden })}</span>
      )}
      {suite.running.length === 0 && suite.current && (
        <span
          className="text-muted-foreground truncate font-mono"
          title={suite.current}
          data-testid={`test-progress-current-${suite.name}`}
        >
          {suite.current}
        </span>
      )}
    </div>
  );
}

function SuiteRow({ suite, now, t }: { suite: TestProgressSuite; now: number; t: T }) {
  const elapsed =
    suite.durationMs ?? (suite.startedAt !== undefined ? now - suite.startedAt : undefined);
  return (
    <li
      data-testid={`test-progress-suite-${suite.name}`}
      data-status={suite.status}
      className="flex min-w-0 flex-col gap-0.5 py-1"
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon status={suite.status} />
        <span className="truncate font-medium">{suite.name}</span>
        {suite.related && (
          <Badge variant="outline" className="shrink-0 px-1.5 py-0 font-normal">
            {t('testProgress.related')}
          </Badge>
        )}
        <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2 tabular-nums">
          <Counts {...suite} />
          {elapsed !== undefined && <span>{formatDuration(elapsed, t)}</span>}
        </span>
      </div>
      {suite.status === 'running' && <SuiteActivity suite={suite} now={now} t={t} />}
    </li>
  );
}

function SlowList({ items, t }: { items: SlowItem[]; t: T }) {
  return (
    <div className="flex flex-col gap-1" data-testid="test-progress-slow">
      <div className="text-muted-foreground flex items-center gap-1.5 font-medium">
        <Timer className="size-3.5" aria-hidden />
        {t('testProgress.slowTitle')}
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li
            key={`${item.suite}:${item.kind}:${item.name}`}
            className="flex min-w-0 items-center gap-2"
            data-running={item.running}
          >
            {item.running ? (
              <Loader2 className="text-primary size-3 shrink-0 animate-spin" aria-hidden />
            ) : (
              <span className="text-muted-foreground w-3 shrink-0 text-center">
                {item.kind === 'file' ? '▤' : '·'}
              </span>
            )}
            <span className="truncate font-mono" title={`${item.suite} — ${item.name}`}>
              {item.name}
            </span>
            <span className="text-muted-foreground shrink-0">{item.suite}</span>
            <span className={cn('ml-auto shrink-0 tabular-nums', TONE.skipped)}>
              {formatDuration(item.durationMs, t)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function failureLocation(failure: TestFailure): string | undefined {
  if (!failure.file) return undefined;
  return failure.line ? `${failure.file}:${failure.line}` : failure.file;
}

/** The failed tests, by name, with where and why; tagged with their suite when several failed. */
function FailureList({ suites, total, t }: { suites: TestProgressSuite[]; total: number; t: T }) {
  const failed = suites.filter((suite) => suite.failures.length > 0);
  const showSuite = failed.length > 1;
  const shown = failed
    .flatMap((suite) => suite.failures.map((failure) => ({ suite: suite.name, failure })))
    .slice(0, FAILURES_SHOWN);
  return (
    <div className="flex flex-col gap-1" data-testid="test-progress-failures">
      <span className="text-muted-foreground font-medium">{t('testProgress.failuresTitle')}</span>
      <ul className="flex flex-col gap-1">
        {shown.map(({ suite, failure }, index) => {
          const location = failureLocation(failure);
          return (
            <li
              key={`${suite}:${index}`}
              className="flex min-w-0 items-start gap-2"
              data-testid={`test-progress-failure-${index}`}
            >
              <XCircle className={cn('mt-0.5 size-3.5 shrink-0', TONE.failed)} aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-mono" title={failure.name}>
                    {failure.name}
                  </span>
                  {showSuite && <span className="text-muted-foreground shrink-0">{suite}</span>}
                  {location && (
                    <span
                      className="text-muted-foreground ml-auto shrink-0 truncate font-mono"
                      title={location}
                    >
                      {location}
                    </span>
                  )}
                </div>
                {failure.message && (
                  <span
                    className="text-muted-foreground line-clamp-3 font-mono break-words whitespace-pre-wrap"
                    title={failure.message}
                  >
                    {failure.message}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {total > shown.length && (
        <span className="text-muted-foreground">
          {t('testProgress.moreFailures', { shown: shown.length, total })}
        </span>
      )}
    </div>
  );
}

function RunHeader({ progress, now, t }: { progress: TestProgress; now: number; t: T }) {
  const running = progress.status === 'running';
  const elapsed = runElapsed(progress, now);
  const active = progress.suites.filter((suite) => suite.status === 'running').length;
  return (
    <div className="flex items-center gap-2">
      <StatusIcon status={progress.status} />
      <span className="font-medium">{t(`testProgress.status.${progress.status}`)}</span>
      {running && (
        <span className="text-muted-foreground tabular-nums" data-testid="test-progress-runners">
          {progress.concurrency
            ? t('testProgress.runners', { count: active, max: progress.concurrency })
            : t('testProgress.runnersNoMax', { count: active })}
        </span>
      )}
      <span
        className="text-muted-foreground ml-auto tabular-nums"
        data-testid="test-progress-elapsed"
      >
        {formatDuration(elapsed, t)}
      </span>
    </div>
  );
}

function TestProgressView({ progress }: { progress: TestProgress }) {
  const { t } = useTranslation();
  const now = useNow(progress.status === 'running');
  const summary = summarizeTestProgress(progress, now);

  return (
    <div
      data-testid="test-progress"
      data-status={progress.status}
      className="bg-card text-card-foreground flex flex-col gap-2 rounded-md border p-3 text-xs"
    >
      <RunHeader progress={progress} now={now} t={t} />
      <Progress value={summary.percent} className="h-1.5" data-testid="test-progress-bar" />

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
        <span data-testid="test-progress-suites">
          {t('testProgress.suites', { done: summary.suitesDone, total: progress.suites.length })}
        </span>
        <span className="tabular-nums">{Math.floor(summary.percent)}%</span>
        <span className={TONE.passed} data-testid="test-progress-passed">
          {t('testProgress.passed', { count: summary.passed })}
        </span>
        {summary.failed > 0 && (
          <span className={TONE.failed} data-testid="test-progress-failed">
            {t('testProgress.failed', { count: summary.failed })}
          </span>
        )}
        {summary.skipped > 0 && (
          <span className={TONE.skipped} data-testid="test-progress-skipped">
            {t('testProgress.skipped', { count: summary.skipped })}
          </span>
        )}
      </div>

      {summary.slow.length > 0 && <SlowList items={summary.slow} t={t} />}

      {progress.suites.some((suite) => suite.failures.length > 0) && (
        <FailureList suites={progress.suites} total={summary.failed} t={t} />
      )}

      <ul className="divide-border/60 divide-y">
        {progress.suites.map((suite) => (
          <SuiteRow key={suite.name} suite={suite} now={now} t={t} />
        ))}
      </ul>

      {progress.suites.some((suite) => suite.files.length > 0) ? (
        <TestFileList suites={progress.suites} />
      ) : (
        // A finished run whose output named no files (filtered, or a runner
        // that prints only totals): say so instead of leaving the list out.
        progress.status !== 'running' && (
          <span className="text-muted-foreground" data-testid="test-progress-no-files">
            {t('testProgress.noFiles')}
          </span>
        )
      )}
    </div>
  );
}

/** Follows the progress file at `path` and renders it. */
export function TestProgressBlock({
  path,
  fallback,
}: {
  path: string | null;
  /** Shown instead of the error when the file cannot be read (e.g. it was cleaned up). */
  fallback?: ReactNode;
}) {
  const state = useTestProgress(path);
  if (state.kind === 'ready') return <TestProgressView progress={state.progress} />;
  if (state.kind === 'error' && fallback) return fallback;
  return <ProgressFileFallback kind={state.kind} path={path} testIdPrefix="test-progress" />;
}
