import { MousePointer2 } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import { useBrowserPointerStore } from '@/stores/browser-pointer-store';

/**
 * The agent's mouse, drawn over the screencast (which never shows a cursor).
 * Glides to each point the runner reports and pulses where it presses.
 * Positioned in percent of the page viewport, so it follows the panel's scale.
 */
export function AgentPointer({
  sessionId,
  viewport,
}: {
  sessionId: string;
  viewport: { width: number; height: number };
}) {
  const pointer = useBrowserPointerStore((s) => s.bySession[sessionId]);
  // The press whose pulse already played. Without this the ping element would
  // stay mounted after its animation and snap back to a solid circle.
  const [pulsedSeq, setPulsedSeq] = useState<number | null>(null);
  if (!pointer || viewport.width <= 0 || viewport.height <= 0) return null;
  const presses = pointer.kind !== 'move';
  const pulsing = presses && pulsedSeq !== pointer.seq;

  return (
    <div
      data-testid="browser-agent-pointer"
      data-pointer-kind={pointer.kind}
      aria-hidden
      className="pointer-events-none absolute top-[var(--agent-pointer-top)] left-[var(--agent-pointer-left)] z-10 transition-[left,top] duration-300 ease-out"
      style={{
        '--agent-pointer-left': `${(pointer.x / viewport.width) * 100}%`,
        '--agent-pointer-top': `${(pointer.y / viewport.height) * 100}%`,
      }}
    >
      {pulsing && (
        <span
          key={pointer.seq}
          data-testid="browser-agent-pointer-pulse"
          onAnimationEnd={() => setPulsedSeq(pointer.seq)}
          className="bg-status-info/50 absolute -top-6 -left-6 size-12 animate-ping rounded-full [animation-iteration-count:2]"
        />
      )}
      {/* Contrast with the remote page, not with funny's theme: black fill and
          white outline, like a system cursor, read on any page background. */}
      <MousePointer2
        strokeWidth={2.5}
        className={cn(
          'relative size-7 fill-black text-white drop-shadow-lg',
          pulsing && 'scale-90 transition-transform',
        )}
      />
    </div>
  );
}
