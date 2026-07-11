import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { dispatchToolCard } from '@/components/tool-cards/dispatch';
import { GenericToolCard } from '@/components/tool-cards/GenericToolCard';
import {
  formatInput,
  getFilePath,
  getSummary,
  getToolLabel,
  getTodos,
  isTodoToolName,
  makeRelativePath,
  useCurrentProjectPath,
} from '@/components/tool-cards/utils';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { stripAnsi } from '@/lib/ansi-to-html';
import { timeAgo } from '@/lib/thread-utils';

interface ToolCallCardProps {
  name: string;
  input: string | Record<string, unknown>;
  output?: string;
  author?: string;
  onRespond?: (answer: string) => void;
  /** When true, hides the tool label (used inside ToolCallGroup to avoid redundancy) */
  hideLabel?: boolean;
  /** Plan text from the parent assistant message (for ExitPlanMode) */
  planText?: string;
  /** Nested tool calls from a subagent (Task tool) */
  childToolCalls?: any[];
  /** ISO timestamp of when this tool call was executed */
  timestamp?: string;
}

function normalizeProviderErrorText(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, '\n').trim();
}

function shouldSuppressDuplicateProviderErrorOutput(
  name: string,
  parsed: Record<string, unknown>,
  output: string | undefined,
): boolean {
  if (name !== 'ProviderError' || !output || typeof parsed.error !== 'string') return false;
  return normalizeProviderErrorText(parsed.error) === normalizeProviderErrorText(output);
}

export const ToolCallCard = memo(
  function ToolCallCard({
    name,
    input,
    output,
    author,
    onRespond,
    hideLabel,
    planText,
    childToolCalls,
    timestamp,
  }: ToolCallCardProps) {
    const { t } = useTranslation();
    useMinuteTick();
    const isTodo = isTodoToolName(name);
    const parsed = useMemo(() => formatInput(input), [input]);
    const label = getToolLabel(isTodo ? 'TodoWrite' : name, t);
    const rawSummary = getSummary(isTodo ? 'TodoWrite' : name, parsed, t);
    // `getSummary` is typed `string | null`, but its `as string` casts are unsafe:
    // a tool's input field can be a non-string (e.g. a number from an MCP tool), and
    // that value flows through untouched. Only run ANSI stripping on real strings —
    // calling `.replace` on a non-string throws and crashes the whole thread view.
    const summary = useMemo(
      () => (typeof rawSummary === 'string' ? stripAnsi(rawSummary) : rawSummary),
      [rawSummary],
    );

    const todos = isTodo ? getTodos(parsed) : null;
    const filePath = getFilePath(name, parsed);
    const projectPath = useCurrentProjectPath();
    const displayPath = filePath ? makeRelativePath(filePath, projectPath) : null;
    const displayTime = useMemo(() => (timestamp ? timeAgo(timestamp, t) : null), [timestamp, t]);
    const displayOutput = useMemo(
      () => (shouldSuppressDuplicateProviderErrorOutput(name, parsed, output) ? undefined : output),
      [name, parsed, output],
    );

    const specialized = dispatchToolCard({
      name,
      parsed,
      output: displayOutput,
      author,
      onRespond,
      hideLabel,
      planText,
      childToolCalls,
      displayTime,
      renderToolCall: (childTc) => (
        <ToolCallCard
          key={childTc.id}
          name={childTc.name}
          input={childTc.input}
          output={childTc.output}
          author={childTc.author}
        />
      ),
    });
    if (specialized) return specialized;

    return (
      <GenericToolCard
        name={name}
        parsed={parsed}
        output={displayOutput}
        onRespond={onRespond}
        hideLabel={hideLabel}
        displayTime={displayTime}
        label={label}
        summary={summary}
        filePath={filePath}
        displayPath={displayPath}
        isTodo={isTodo}
        todos={todos}
      />
    );
  },
  (prev, next) => {
    return (
      prev.name === next.name &&
      prev.input === next.input &&
      prev.output === next.output &&
      prev.author === next.author &&
      prev.hideLabel === next.hideLabel &&
      !!prev.onRespond === !!next.onRespond &&
      prev.planText === next.planText &&
      prev.childToolCalls === next.childToolCalls &&
      prev.timestamp === next.timestamp
    );
  },
);
