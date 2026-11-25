import type { BrowserSessionAgentActionKind } from '@funny/shared';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
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

/** A page point as CSS lengths. */
type Point = { left: string; top: string };

/**
 * An element placed at a point sets it as `--agent-action-left` / `--agent-action-top`
 * and adds these classes, which read them into `left` / `top`.
 */
const AT_POINT_CLASSES = 'left-[var(--agent-action-left)] top-[var(--agent-action-top)]';

function at(viewport: Viewport, x: number, y: number): Point {
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
  const CursorIcon =
    Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ArrowRight : ArrowLeft) : dy < 0 ? ArrowUp : ArrowDown;
  return (
    <CursorIcon
      data-testid="browser-agent-action-scroll"
      strokeWidth={3}
      className="size-8 -translate-x-1/2 -translate-y-1/2 fill-black text-white drop-shadow-lg"
    />
  );
}

/** What each effect gets: the action, where it happens (if anywhere) and the viewport. */
interface EffectProps {
  action: AgentActionState;
  point: Point | null;
  viewport: Viewport;
  done: () => void;
}

function ScreenshotFlash({ done }: EffectProps) {
  return (
    <div
      data-testid="browser-agent-action-flash"
      onAnimationEnd={done}
      className="animate-out fade-out absolute inset-0 bg-white/80 [animation-duration:500ms] [animation-fill-mode:forwards]"
    />
  );
}

function DragTrail({ action, viewport }: EffectProps) {
  const { x, y, toX, toY } = action;
  if (x === undefined || y === undefined || toX === undefined || toY === undefined) return null;
  return (
    <svg
      data-testid="browser-agent-action-drag"
      className="absolute inset-0 size-full"
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      preserveAspectRatio="none"
    >
      <line
        x1={x}
        y1={y}
        x2={toX}
        y2={toY}
        strokeWidth={3}
        strokeDasharray="8 6"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className="stroke-status-info"
      />
    </svg>
  );
}

function DoubleClickRing({ point }: EffectProps) {
  if (!point) return null;
  return (
    <span
      className={cn(
        'bg-status-info/40 absolute size-12 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full [animation-delay:150ms] [animation-iteration-count:2]',
        AT_POINT_CLASSES,
      )}
      style={{ '--agent-action-left': point.left, '--agent-action-top': point.top }}
    />
  );
}

function ScrollMarker({ action, point }: EffectProps) {
  if (!point) return null;
  return (
    <div
      className={cn('absolute', AT_POINT_CLASSES)}
      style={{ '--agent-action-left': point.left, '--agent-action-top': point.top }}
    >
      <ScrollArrow action={action} />
    </div>
  );
}

function PressedKey({ action }: EffectProps) {
  return (
    <kbd
      data-testid="browser-agent-action-key"
      className="bg-foreground/85 text-background absolute bottom-6 left-1/2 -translate-x-1/2 rounded-md px-3 py-1.5 font-mono text-sm shadow-lg"
    >
      {action.detail}
    </kbd>
  );
}

/** The chip by the cursor (bottom left without a point); its fade-out ends the effect. */
function ActionLabel({ action, point, done }: EffectProps) {
  return (
    <span
      data-testid="browser-agent-action-label"
      onAnimationEnd={done}
      className={cn(
        'animate-out fade-out bg-foreground/85 text-background absolute translate-x-5 translate-y-5 rounded-full px-2 py-0.5 text-xs whitespace-nowrap shadow-md [animation-delay:1000ms] [animation-duration:500ms] [animation-fill-mode:both]',
        point ? AT_POINT_CLASSES : 'bottom-3 left-3 [transform:none]',
      )}
      style={
        point ? { '--agent-action-left': point.left, '--agent-action-top': point.top } : undefined
      }
    >
      {labelFor(action)}
    </span>
  );
}

/** The effect each action draws besides the label; a screenshot draws only its flash. */
const KIND_EFFECTS: Partial<
  Record<BrowserSessionAgentActionKind, (props: EffectProps) => ReactNode>
> = {
  screenshot: ScreenshotFlash,
  drag: DragTrail,
  double_click: DoubleClickRing,
  scroll: ScrollMarker,
  press: PressedKey,
};

function pointOf(action: AgentActionState, viewport: Viewport) {
  return action.x !== undefined && action.y !== undefined ? at(viewport, action.x, action.y) : null;
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
  const props: EffectProps = {
    action,
    point: pointOf(action, viewport),
    viewport,
    done: () => setPlayedSeq(action.seq),
  };
  const Effect = KIND_EFFECTS[action.kind];

  return (
    <div
      key={action.seq}
      data-testid="browser-agent-action"
      data-action-kind={action.kind}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      {Effect && <Effect {...props} />}
      {action.kind !== 'screenshot' && <ActionLabel {...props} />}
    </div>
  );
}
