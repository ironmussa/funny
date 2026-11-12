/**
 * The card for a `funny_run_checks` call (tests, type check, lint, format,
 * build). While it runs, the runner's `agent:check_run` announcement (matched
 * by `checkInputKey(input)`) names the progress file, so the widget follows it
 * live; once it returns, the result carries `progressPath`. If the file is
 * gone, the summary shows. A check the agent runs through Bash stays a plain
 * Bash card: only funny's own runs get the widget.
 */
import { checkInputKey } from '@funny/shared/checks';
import { ChevronRight, ListChecks } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProgressLoading } from '@/components/progress/progress-parts';
import { TaskProgressBlock } from '@/components/TaskProgressBlock';
import { TestProgressBlock } from '@/components/TestProgressBlock';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useCheckRun } from '@/stores/check-runs-store';
import { useThreadId } from '@/stores/thread-context';

import { parseMcpResult } from './mcp-tool';

const PROGRESS_PATH = /^progressPath: (\S+)$/m;
const COMMAND_LINE = /^\$ (.+?) {2}\(in (.+)\)$/m;
const KINDS = new Set(['test', 'typecheck', 'lint', 'format', 'build', 'verify']);

/** The text of a tool result (the MCP envelope's text parts, or the raw output). */
function resultText(output: string | undefined): string {
  if (!output) return '';
  const result = parseMcpResult(output);
  if (!result) return output;
  return result.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('\n');
}

interface CheckResult {
  path: string | null;
  kind: string | null;
  command: string | null;
  cwd: string | null;
}

const RESULT_KIND = /^(\w+) (?:PASSED|FAILED|TIMED OUT|CANCELLED)\b/;

/** Group `index` of the first match of `pattern` in `text`, or null. */
const capture = (pattern: RegExp, text: string, index = 1): string | null =>
  pattern.exec(text)?.[index] ?? null;

/** What the result says: its progress file, the kind it ran (`test FAILED …`) and the command (`$ … (in cwd)`). */
function readCheckResult(text: string): CheckResult {
  const kind = capture(RESULT_KIND, text);
  return {
    path: capture(PROGRESS_PATH, text),
    kind: kind && KINDS.has(kind) ? kind : null,
    command: capture(COMMAND_LINE, text, 1),
    cwd: capture(COMMAND_LINE, text, 2),
  };
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * What the run covers: the command it ran once the result names it (it already
 * includes the scope and filter), else what the call asked for (a custom
 * command, or its scope and test-name filter) while it is still running.
 */
function CheckRunDetails({
  parsed,
  command,
  cwd,
}: {
  parsed: Record<string, unknown>;
  command: string | null;
  cwd: string | null;
}) {
  const { t } = useTranslation();
  const requested = typeof parsed.command === 'string' ? parsed.command : null;
  const scope = stringList(parsed.scope);
  const filter = typeof parsed.filter === 'string' ? parsed.filter : null;
  const shown = command ?? requested;

  if (shown) {
    return (
      <div
        className="text-muted-foreground px-3 pb-1.5 font-mono text-xs break-all"
        title={cwd ? t('checks.cwd', { cwd }) : undefined}
        data-testid="check-run-command"
      >
        <span className="text-muted-foreground/60 select-none">$ </span>
        {shown}
      </div>
    );
  }
  if (scope.length === 0 && !filter) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1 px-3 pb-1.5 text-xs"
      data-testid="check-run-scope"
    >
      {scope.map((item) => (
        <Badge
          key={item}
          variant="outline"
          className="max-w-full truncate px-1.5 py-0 font-mono font-normal"
          title={item}
        >
          {item}
        </Badge>
      ))}
      {filter && (
        <Badge variant="secondary" className="px-1.5 py-0 font-mono font-normal">
          {t('checks.filter', { filter })}
        </Badge>
      )}
    </div>
  );
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
      className="text-muted-foreground overflow-x-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap"
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
    command: result.command,
    cwd: result.cwd,
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
  return summary ?? <ProgressLoading label={t('checks.starting')} testId="check-run-starting" />;
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
  const { path, kind, text, command, cwd } = useCheckRunSource(parsed, output);
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
      <CheckRunDetails parsed={parsed} command={command} cwd={cwd} />
      <div className="border-border/40 border-t p-2">
        <CheckRunBody path={path} kind={kind} text={text} />
      </div>
      {canExpand && showSummary && <SummaryText text={text} testId="check-run-result-text" />}
    </div>
  );
}
