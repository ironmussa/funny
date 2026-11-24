import type { BrowserSessionAgentActionKind } from '@funny/shared';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { useState } from 'react';

import { useBrowserPointerStore, type AgentActionState } from '@/stores/browser-pointer-store';

/** What the chip by the agent's cursor says for each action. */
const ACTION_LABELS: Record<BrowserSessionAgentActionKind, string> = {
  click: 'Click',
  double_click: 'Double-click',
  hover: 'Hover',
  type: 'Typing',
  fill: 'Fill',
  select: 'Select',
  press: 'Key',
  scroll: 'Scroll',
  drag: 'Drag',
  upload: 'Upload',
  screenshot: 'Screenshot',
};

/** How the effects place a page point: percent of the page viewport. */
type Viewport = { width: number; height: number };

function at(viewport: Viewport, x: number, y: number) {
  return { left: `${(x / viewport.width) * 100}%`, top: `${(y / viewport.height) * 100}%` };
}

function labelFor(action: AgentActionState): string {
  const label = ACTION_LABELS[action.kind];
  if (action.kind === 'upload' && action.detail) {
    return `${label} · ${action.detail} file${action.detail === '1' ? '' : 's'}`;
  }
  return action.detail ? `${label} · ${action.detail}` : label;
}

function ScrollArrow({ action }: { action: AgentActionState }) {
  const dx = action.deltaX ?? 0;
  const dy = action.deltaY ?? 0;
  const Icon =
    Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ArrowRight : ArrowLeft) : dy < 0 ? ArrowUp : ArrowDown;
  return (
    <Icon
      data-testid="browser-agent-action-scroll"
      strokeWidth={3}
      className="size-8 -translate-x-1/2 -translate-y-1/2 fill-black text-white drop-shadow-lg"
    />
  );
}

/**
 * What the agent just did, drawn once over the screencast: a label by the
 * cursor, a second ring for a double-click, an arrow for a scroll, a trail for
 * a drag, the key it pressed and a flash for a screenshot. Each effect plays
 * once per action (`seq`) and then unmounts.
 */
export function AgentActionEffects({
  sessionId,
  viewport,
}: {
  sessionId: string;
  viewport: Viewport;
}) {
  const action = useBrowserPointerStore((s) => s.actionBySession[sessionId]);
  // The action whose effect already played, so it does not replay on re-render.
  const [playedSeq, setPlayedSeq] = useState<number | null>(null);
  if (!action || playedSeq === action.seq) return null;
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const done = () => setPlayedSeq(action.seq);
  const point =
    action.x !== undefined && action.y !== undefined ? at(viewport, action.x, action.y) : null;

  return (
    <div
      key={action.seq}
      data-testid="browser-agent-action"
      data-action-kind={action.kind}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      {action.kind === 'screenshot' && (
        <div
          data-testid="browser-agent-action-flash"
          onAnimationEnd={done}
          className="animate-out fade-out absolute inset-0 bg-white/80 [animation-duration:500ms] [animation-fill-mode:forwards]"
        />
      )}

      {action.kind === 'drag' && action.x !== undefined && action.y !== undefined && (
        <svg
          data-testid="browser-agent-action-drag"
          className="absolute inset-0 size-full"
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
          preserveAspectRatio="none"
        >
          {action.toX !== undefined && action.toY !== undefined && (
            <line
              x1={action.x}
              y1={action.y}
              x2={action.toX}
              y2={action.toY}
              strokeWidth={3}
              strokeDasharray="8 6"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="stroke-status-info"
            />
          )}
        </svg>
      )}

      {action.kind === 'double_click' && point && (
        <span
          className="bg-status-info/40 absolute size-12 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full [animation-delay:150ms] [animation-iteration-count:2]"
          style={point}
        />
      )}

      {action.kind === 'scroll' && point && (
        <div className="absolute" style={point}>
          <ScrollArrow action={action} />
        </div>
      )}

      {action.kind === 'press' && (
        <kbd
          data-testid="browser-agent-action-key"
          className="bg-foreground/85 text-background absolute bottom-6 left-1/2 -translate-x-1/2 rounded-md px-3 py-1.5 font-mono text-sm shadow-lg"
        >
          {action.detail}
        </kbd>
      )}

      {/* The label chip; its fade-out ends the whole effect, so it always
          renders (bottom left when the action has no point). */}
      {action.kind !== 'screenshot' && (
        <span
          data-testid="browser-agent-action-label"
          onAnimationEnd={done}
          className="animate-out fade-out bg-foreground/85 text-background absolute translate-x-5 translate-y-5 rounded-full px-2 py-0.5 text-xs whitespace-nowrap shadow-md [animation-delay:1000ms] [animation-duration:500ms] [animation-fill-mode:both]"
          style={point ?? { left: '0.75rem', bottom: '0.75rem', transform: 'none' }}
        >
          {labelFor(action)}
        </span>
      )}
    </div>
  );
}
