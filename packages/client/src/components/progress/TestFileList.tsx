import type { TestFileResult, TestProgressSuite, TestResult } from '@funny/shared/test-progress';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  formatDuration,
  StatusIcon,
  TONE,
  type TFunction,
} from '@/components/progress/progress-parts';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const MARK: Record<TestResult['state'], { mark: string; tone: string }> = {
  passed: { mark: '✓', tone: TONE.passed },
  failed: { mark: '✗', tone: TONE.failed },
  skipped: { mark: '○', tone: TONE.skipped },
};

/** Rows rendered at first, and added by each "show more". */
const ROWS_PAGE = 100;

/** The first `shown` items, and a way to show `ROWS_PAGE` more. */
function usePage<T>(items: T[]) {
  const [shown, setShown] = useState(ROWS_PAGE);
  return {
    visible: items.slice(0, shown),
    hidden: Math.max(0, items.length - shown),
    more: () => setShown((n) => n + ROWS_PAGE),
  };
}

function ShowMore({
  hidden,
  onClick,
  testId,
  className,
}: {
  hidden: number;
  onClick: () => void;
  testId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  if (hidden === 0) return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onClick}
      data-testid={testId}
      className={cn('text-muted-foreground self-start', className)}
    >
      {t('testProgress.showMore', { count: Math.min(ROWS_PAGE, hidden), hidden })}
    </Button>
  );
}

/** Durations under a second are not worth a column. */
const shownDuration = (ms: number | undefined, t: TFunction) =>
  ms !== undefined && ms >= 1_000 ? formatDuration(ms, t) : null;

const fileStatus = (file: TestFileResult) => file.status ?? (file.failed > 0 ? 'failed' : 'passed');

function TestRow({ test, t }: { test: TestResult; t: TFunction }) {
  const { mark, tone } = MARK[test.state];
  const duration = shownDuration(test.durationMs, t);
  return (
    <li className="flex min-w-0 items-center gap-2" data-state={test.state}>
      <span className={cn('w-3 shrink-0 text-center', tone)}>{mark}</span>
      <span className="truncate font-mono" title={test.name}>
        {test.name}
      </span>
      {duration && (
        <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">{duration}</span>
      )}
    </li>
  );
}

function FileRow({ file, label, t }: { file: TestFileResult; label: string; t: TFunction }) {
  const [open, setOpen] = useState(false);
  const expandable = file.tests.length > 0;
  const duration = shownDuration(file.durationMs, t);
  const page = usePage(file.tests);
  return (
    <li data-testid={`test-progress-file-${label}`} data-status={fileStatus(file)}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          disabled={!expandable}
          data-testid={`test-progress-file-toggle-${label}`}
          className="hover:bg-accent/30 flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left disabled:cursor-default disabled:hover:bg-transparent"
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground',
              open && 'rotate-90',
              !expandable && 'invisible',
            )}
            aria-hidden
          />
          <StatusIcon status={fileStatus(file)} />
          <span className="truncate font-mono" title={label}>
            {label}
          </span>
          <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2 tabular-nums">
            {file.passed > 0 && <span className={TONE.passed}>✓ {file.passed}</span>}
            {file.failed > 0 && <span className={TONE.failed}>✗ {file.failed}</span>}
            {file.skipped > 0 && <span className={TONE.skipped}>○ {file.skipped}</span>}
            {duration && <span>{duration}</span>}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="flex flex-col gap-0.5 py-0.5 pl-9">
            {page.visible.map((test, index) => (
              <TestRow key={`${test.name}:${index}`} test={test} t={t} />
            ))}
          </ul>
          <ShowMore
            hidden={page.hidden}
            onClick={page.more}
            testId={`test-progress-tests-more-${label}`}
            className="ml-8"
          />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * Every file the run reported, failed ones first, each expanding to its tests.
 * Folded by default: the counts above and the failure list cover the usual
 * question; this answers "which tests ran".
 */
export function TestFileList({ suites }: { suites: TestProgressSuite[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const several = suites.filter((suite) => suite.files.length > 0).length > 1;
  const files = suites
    .flatMap((suite) =>
      suite.files.map((file) => {
        const name = file.name || suite.name;
        return { file, label: several && file.name ? `${suite.name} › ${name}` : name };
      }),
    )
    .sort(
      (a, b) => Number(fileStatus(b.file) === 'failed') - Number(fileStatus(a.file) === 'failed'),
    );
  const tests = files.reduce((n, { file }) => n + file.passed + file.failed + file.skipped, 0);
  const page = usePage(files);

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="test-progress-files-list">
      <CollapsibleTrigger
        data-testid="test-progress-files-toggle"
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 font-medium"
      >
        <ChevronRight className={cn('size-3.5 shrink-0', open && 'rotate-90')} aria-hidden />
        {t('testProgress.ranTitle')}
        <span className="font-normal tabular-nums">
          {t('testProgress.ranSummary', { tests, files: files.length })}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col pt-1">
          {page.visible.map(({ file, label }) => (
            <FileRow key={label} file={file} label={label} t={t} />
          ))}
        </ul>
        <ShowMore hidden={page.hidden} onClick={page.more} testId="test-progress-files-more" />
      </CollapsibleContent>
    </Collapsible>
  );
}
