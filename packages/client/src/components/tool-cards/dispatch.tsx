import type { ReactNode } from 'react';

import { ToolCallGroup, type ToolCallItem } from '@/components/ToolCallGroup';

import { AskQuestionCard } from './AskQuestionCard';
import { BashCard } from './BashCard';
import { CheckRunCard } from './check-cards';
import { EditFileCard } from './EditFileCard';
import { ExitPlanModeCard } from './ExitPlanModeCard';
import { parseMcpToolName } from './mcp-tool';
import { McpToolCard } from './McpToolCard';
import { PlanCard } from './PlanCard';
import { ReadFileCard } from './ReadFileCard';
import { TaskCard } from './TaskCard';
import { ThinkCard } from './ThinkCard';
import { WriteFileCard } from './WriteFileCard';

interface Args {
  name: string;
  parsed: Record<string, any>;
  output?: string;
  author?: string;
  onRespond?: (answer: string) => void;
  hideLabel?: boolean;
  planText?: string;
  childToolCalls?: any[];
  displayTime: string | null;
  /** Forwarded to TaskCard for nested rendering. */
  renderToolCall: (tc: ToolCallItem) => ReactNode;
}

type CardRenderer = (args: Args) => ReactNode;

const renderTask: CardRenderer = ({
  parsed,
  output,
  hideLabel,
  childToolCalls,
  displayTime,
  renderToolCall,
}) => (
  <TaskCard
    parsed={parsed}
    output={output}
    hideLabel={hideLabel}
    childToolCalls={childToolCalls}
    displayTime={displayTime}
    renderChild={(item) =>
      item.type === 'toolcall-group' ? (
        <ToolCallGroup
          key={`group-${item.name}-${item.calls.map((call) => call.id).join('-')}`}
          name={item.name}
          calls={item.calls}
          timestamp={item.calls[0]?.timestamp}
          renderCall={renderToolCall}
        />
      ) : (
        renderToolCall(item.tc)
      )
    }
  />
);

const CARD_RENDERERS: Record<string, CardRenderer> = {
  Bash: ({ parsed, output, author, hideLabel, displayTime }) => (
    <BashCard
      parsed={parsed}
      output={output}
      author={author}
      hideLabel={hideLabel}
      displayTime={displayTime}
    />
  ),
  Read: ({ parsed, output, hideLabel, displayTime }) => (
    <ReadFileCard parsed={parsed} output={output} hideLabel={hideLabel} displayTime={displayTime} />
  ),
  Write: ({ parsed, hideLabel, displayTime }) => (
    <WriteFileCard parsed={parsed} hideLabel={hideLabel} displayTime={displayTime} />
  ),
  Edit: ({ parsed, hideLabel, displayTime }) => (
    <EditFileCard parsed={parsed} hideLabel={hideLabel} displayTime={displayTime} />
  ),
  AskUserQuestion: ({ parsed, output, onRespond, hideLabel, displayTime }) => (
    <AskQuestionCard
      parsed={parsed}
      onRespond={output ? undefined : onRespond}
      output={output}
      hideLabel={hideLabel}
      displayTime={displayTime}
    />
  ),
  Task: renderTask,
  Agent: renderTask,
  Think: ({ parsed, output, hideLabel, displayTime }) => (
    <ThinkCard parsed={parsed} output={output} hideLabel={hideLabel} displayTime={displayTime} />
  ),
};

/**
 * Routes a tool call to its specialized renderer. Returns `null` when the
 * tool name doesn't match any specialized card, so the caller falls back to
 * GenericToolCard.
 *
 * Extracted from ToolCallCard so the parent doesn't import every specialized
 * card directly (drops ~9 fan-out edges).
 */
export function dispatchToolCard(args: Args): ReactNode | null {
  const { name, parsed, output, onRespond, hideLabel, planText, displayTime } = args;
  const mcp = parseMcpToolName(name);
  if (mcp?.server === 'funny' && mcp.tool === 'funny_run_checks')
    return <CheckRunCard parsed={parsed} output={output} displayTime={displayTime} />;
  if (mcp)
    return (
      <McpToolCard
        mcp={mcp}
        parsed={parsed}
        output={output}
        hideLabel={hideLabel}
        displayTime={displayTime}
      />
    );

  if (name === 'ExitPlanMode')
    return (
      <ExitPlanModeCard
        plan={planText || (typeof parsed.plan === 'string' ? parsed.plan : undefined)}
        onRespond={output ? undefined : onRespond}
        output={output}
        displayTime={displayTime}
      />
    );
  if (typeof parsed.plan === 'string' && parsed.plan.length > 0)
    return (
      <PlanCard parsed={parsed} output={output} hideLabel={hideLabel} displayTime={displayTime} />
    );
  const render = Object.hasOwn(CARD_RENDERERS, name) ? CARD_RENDERERS[name] : null;
  return render ? render(args) : null;
}
