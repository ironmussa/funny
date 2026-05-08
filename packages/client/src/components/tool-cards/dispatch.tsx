import type { ReactNode } from 'react';

import { ToolCallGroup, type ToolCallItem } from '@/components/ToolCallGroup';

import { AskQuestionCard } from './AskQuestionCard';
import { BashCard } from './BashCard';
import { EditFileCard } from './EditFileCard';
import { ExitPlanModeCard } from './ExitPlanModeCard';
import { PlanCard } from './PlanCard';
import { ReadFileCard } from './ReadFileCard';
import { TaskCard } from './TaskCard';
import { ThinkCard } from './ThinkCard';
import { WriteFileCard } from './WriteFileCard';

interface Args {
  name: string;
  parsed: Record<string, any>;
  output?: string;
  onRespond?: (answer: string) => void;
  hideLabel?: boolean;
  planText?: string;
  childToolCalls?: any[];
  displayTime: string | null;
  /** Forwarded to TaskCard for nested rendering. */
  renderToolCall: (tc: ToolCallItem) => ReactNode;
}

/**
 * Routes a tool call to its specialized renderer. Returns `null` when the
 * tool name doesn't match any specialized card, so the caller falls back to
 * GenericToolCard.
 *
 * Extracted from ToolCallCard so the parent doesn't import every specialized
 * card directly (drops ~9 fan-out edges).
 */
export function dispatchToolCard({
  name,
  parsed,
  output,
  onRespond,
  hideLabel,
  planText,
  childToolCalls,
  displayTime,
  renderToolCall,
}: Args): ReactNode | null {
  const isPlan = typeof parsed.plan === 'string' && parsed.plan.length > 0;

  if (name === 'ExitPlanMode')
    return (
      <ExitPlanModeCard
        plan={planText || (typeof parsed.plan === 'string' ? parsed.plan : undefined)}
        onRespond={output ? undefined : onRespond}
        output={output}
        displayTime={displayTime}
      />
    );
  if (isPlan)
    return (
      <PlanCard parsed={parsed} output={output} hideLabel={hideLabel} displayTime={displayTime} />
    );
  if (name === 'Bash')
    return (
      <BashCard parsed={parsed} output={output} hideLabel={hideLabel} displayTime={displayTime} />
    );
  if (name === 'Read')
    return (
      <ReadFileCard
        parsed={parsed}
        output={output}
        hideLabel={hideLabel}
        displayTime={displayTime}
      />
    );
  if (name === 'Write')
    return <WriteFileCard parsed={parsed} hideLabel={hideLabel} displayTime={displayTime} />;
  if (name === 'Edit')
    return <EditFileCard parsed={parsed} hideLabel={hideLabel} displayTime={displayTime} />;
  if (name === 'AskUserQuestion')
    return (
      <AskQuestionCard
        parsed={parsed}
        onRespond={output ? undefined : onRespond}
        output={output}
        hideLabel={hideLabel}
        displayTime={displayTime}
      />
    );
  if (name === 'Task' || name === 'Agent')
    return (
      <TaskCard
        parsed={parsed}
        output={output}
        hideLabel={hideLabel}
        childToolCalls={childToolCalls}
        displayTime={displayTime}
        renderChild={(item, idx) =>
          item.type === 'toolcall-group' ? (
            <ToolCallGroup key={`group-${item.name}-${idx}`} name={item.name} calls={item.calls} />
          ) : (
            renderToolCall(item.tc)
          )
        }
      />
    );
  if (name === 'Think')
    return (
      <ThinkCard parsed={parsed} output={output} hideLabel={hideLabel} displayTime={displayTime} />
    );
  return null;
}
