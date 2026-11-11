/**
 * Cards for the checks an agent runs (tests, type check, lint, format, build):
 *
 * - `CheckRunCard` — a `funny_run_checks` call. While it runs, the runner's
 *   `agent:check_run` announcement (matched by `checkInputKey(input)`) names
 *   the progress file, so the widget follows it live; once it returns, the
 *   result carries `progressPath`. If the file is gone, the summary shows.
 * - `BashCheckCard` — a plain Bash call: when its command is a check and its
 *   output proves the result (`summarizeCheckOutput`), the same widget shows
 *   that result above the normal Bash card; otherwise just the Bash card.
 */
import {
  checkInputKey,
  classifyCheckCommand,
  splitExitCode,
  summarizeCheckOutput,
} from '@funny/shared/checks';
import { ChevronRight, ListChecks } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TaskProgressBlock, TaskProgressView } from '@/components/TaskProgressBlock';
import { TestProgressBlock, TestProgressView } from '@/components/TestProgressBlock';
import { LoadingState } from '@/components/ui/loading-state';
import { cn } from '@/lib/utils';
import { useCheckRun } from '@/stores/check-runs-store';
import { useThreadId } from '@/stores/thread-context';

import { BashCard } from './BashCard';
import { parseMcpResult } from './mcp-tool';

const PROGRESS_PATH = /^progressPath: (\S+)$/m;
const KINDS = new Set(['test', 'typecheck', 'lint', 'format', 'build', 'verify']);

/** The text of a tool result (the MCP envelope's text parts, or the raw output). */
function resultText(output: string | undefined): string {
  if (!output) return '';
  const result = parseMcpResult(output);
  if (!result) return output;
  return result.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('\n');
}

/** What the result says: its progress file and the kind it ran (`test FAILED …`). */
function readCheckResult(text: string): { path: string | null; kind: string | null } {
  const kind = /^(\w+) (?:PASSED|FAILED|TIMED OUT|CANCELLED)\b/.exec(text)?.[1] ?? null;
  return {
    path: PROGRESS_PATH.exec(text)?.[1] ?? null,
    kind: kind && KINDS.has(kind) ? kind : null,
  };
}

function CheckHeader({
  label,
  displayTime,
  expanded,
  onToggle,
  testId,
}: {
  label: string;
  displayTime: string | null;
  expanded?: boolean;
  onToggle?: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={onToggle ? expanded : undefined}
      onClick={onToggle}
      disabled={!onToggle}
      data-testid={testId}
      className="hover:bg-accent/30 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs disabled:cursor-default disabled:hover:bg-transparent"
    >
      {onToggle && (
        <ChevronRight
          className={cn('icon-xs shrink-0 text-muted-foreground', expanded && 'rotate-90')}
        />
      )}
      <ListChecks className="icon-xs text-muted-foreground shrink-0" />
      <span className="text-foreground min-w-0 truncate font-mono font-medium">{label}</span>
      {displayTime && (
        <span className="text-muted-foreground/50 ml-auto shrink-0 text-xs tabular-nums">
          {displayTime}
        </span>
      )}
    </button>
  );
}

function SummaryText({ text, testId }: { text: string; testId: string }) {
  return (
    <pre
      data-testid={testId}
      className="text-muted-foreground overflow-x-auto px-3 py-2 font-mono text-[length:var(--code-font-size)] whitespace-pre-wrap"
    >
      {text}
    </pre>
  );
}

/** Where a call's progress is: its result once it returned, else the runner's announcement. */
function useCheckRunSource(parsed: Record<string, unknown>, output: string | undefined) {
  const threadId = useThreadId();
  const inputKey = useMemo(() => checkInputKey(parsed), [parsed]);
  const announced = useCheckRun(threadId, inputKey);
  const text = useMemo(() => resultText(output), [output]);
  const result = useMemo(() => readCheckResult(text), [text]);
  const requested = typeof parsed.kind === 'string' ? parsed.kind : 'test';
  return {
    text,
    path: result.path ?? announced?.path ?? null,
    kind: result.kind ?? announced?.kind ?? requested,
  };
}

/** The widget for the run, its summary when the file is gone, or "starting". */
function CheckRunBody({ path, kind, text }: { path: string | null; kind: string; text: string }) {
  const { t } = useTranslation();
  const summary = text ? <SummaryText text={text} testId="check-run-summary" /> : null;
  if (path && kind === 'test') return <TestProgressBlock path={path} fallback={summary} />;
  if (path) return <TaskProgressBlock path={path} fallback={summary} />;
  return (
    summary ?? (
      <LoadingState
        layout="inline"
        fill={false}
        label={t('checks.starting')}
        testId="check-run-starting"
      />
    )
  );
}

/** A `funny_run_checks` call: its live widget, then its result. */
export function CheckRunCard({
  parsed,
  output,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  displayTime: string | null;
}) {
  const { t } = useTranslation();
  const [showSummary, setShowSummary] = useState(false);
  const { path, kind, text } = useCheckRunSource(parsed, output);
  const canExpand = Boolean(path && text);

  return (
    <div
      className="border-border max-w-full overflow-hidden rounded-lg border text-sm"
      data-testid="check-run-card"
    >
      <CheckHeader
        label={t('checks.run', { kind })}
        displayTime={displayTime}
        expanded={showSummary}
        onToggle={canExpand ? () => setShowSummary(!showSummary) : undefined}
        testId="check-run-toggle"
      />
      <div className="border-border/40 border-t p-2">
        <CheckRunBody path={path} kind={kind} text={text} />
      </div>
      {canExpand && showSummary && <SummaryText text={text} testId="check-run-result-text" />}
    </div>
  );
}

interface BashProps {
  parsed: Record<string, unknown>;
  output?: string;
  author?: string;
  hideLabel?: boolean;
  displayTime: string | null;
}

/** A Bash call: the check widget for a recognised check with a provable result, then the Bash card. */
export function BashCheckCard(props: BashProps) {
  const { parsed, output } = props;
  const summary = useMemo(() => {
    const command = typeof parsed.command === 'string' ? parsed.command : null;
    const check = command && output ? classifyCheckCommand(command) : null;
    if (!check || !output) return null;
    const { exitCode, output: body } = splitExitCode(output);
    return summarizeCheckOutput(check, body, { exitCode, at: 0 });
  }, [parsed.command, output]);

  if (!summary) return <BashCard {...props} />;
  return (
    <div className="flex flex-col gap-1.5" data-testid="check-result-card">
      <BashCard {...props} />
      <div className="border-border rounded-lg border p-2">
        {summary.kind === 'test' ? (
          <TestProgressView progress={summary.progress} />
        ) : (
          <TaskProgressView progress={summary.progress} />
        )}
      </div>
    </div>
  );
}
