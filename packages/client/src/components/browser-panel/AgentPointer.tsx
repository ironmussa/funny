import { MousePointer2 } from 'lucide-react';

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
  if (!pointer || viewport.width <= 0 || viewport.height <= 0) return null;
  const presses = pointer.kind !== 'move';

  return (
    <div
      data-testid="browser-agent-pointer"
      data-pointer-kind={pointer.kind}
      aria-hidden
      className="pointer-events-none absolute z-10 transition-[left,top] duration-300 ease-out"
      style={{
        left: `${(pointer.x / viewport.width) * 100}%`,
        top: `${(pointer.y / viewport.height) * 100}%`,
      }}
    >
      {/* Always-on halo so the cursor stands out in a small, scaled-down panel. */}
      <span className="bg-status-info/30 ring-status-info/60 absolute -top-4 -left-4 size-8 rounded-full ring-2" />
      {presses && (
        <span
          key={pointer.seq}
          className="bg-status-info/50 absolute -top-6 -left-6 size-12 animate-ping rounded-full [animation-iteration-count:2]"
        />
      )}
      {/* Contrast with the remote page, not with funny's theme: black fill and
          white outline, like a system cursor, read on any page background. */}
      <MousePointer2
        strokeWidth={2.5}
        className={cn(
          'relative size-7 fill-black text-white drop-shadow-lg',
          presses && 'scale-90 transition-transform',
        )}
      />
    </div>
  );
}
