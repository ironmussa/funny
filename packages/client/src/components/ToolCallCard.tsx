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
  makeRelativePath,
  useCurrentProjectPath,
} from '@/components/tool-cards/utils';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { timeAgo } from '@/lib/thread-utils';

interface ToolCallCardProps {
  name: string;
  input: string | Record<string, unknown>;
  output?: string;
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

export const ToolCallCard = memo(
  function ToolCallCard({
    name,
    input,
    output,
    onRespond,
    hideLabel,
    planText,
    childToolCalls,
    timestamp,
  }: ToolCallCardProps) {
    const { t } = useTranslation();
    const tick = useMinuteTick();
    const isTodo = name === 'TodoWrite';
    const parsed = useMemo(() => formatInput(input), [input]);
    const label = getToolLabel(name, t);
    const summary = getSummary(name, parsed, t);

    const todos = isTodo ? getTodos(parsed) : null;
    const filePath = getFilePath(name, parsed);
    const projectPath = useCurrentProjectPath();
    const displayPath = filePath ? makeRelativePath(filePath, projectPath) : null;
    const displayTime = useMemo(
      () => (timestamp ? timeAgo(timestamp, t) : null),
      [timestamp, t, tick],
    );

    const specialized = dispatchToolCard({
      name,
      parsed,
      output,
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
        />
      ),
    });
    if (specialized) return specialized;

    return (
      <GenericToolCard
        name={name}
        parsed={parsed}
        output={output}
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
      prev.hideLabel === next.hideLabel &&
      !!prev.onRespond === !!next.onRespond &&
      prev.planText === next.planText &&
      prev.childToolCalls === next.childToolCalls &&
      prev.timestamp === next.timestamp
    );
  },
);
