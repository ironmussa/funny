/**
 * SandboxErrorCard — a sandbox / provider failure in the thread's timeline
 * (change thread-sandboxes): what failed, the provider's message, and what the
 * user can do about it. Posted by the server as a `sandbox:error` event.
 */

import type { ThreadEvent } from '@funny/shared';
import { CircleX } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useMinuteTick } from '@/hooks/use-minute-tick';
import { timeAgo } from '@/lib/thread-utils';

interface SandboxErrorData {
  phase?: 'setup' | 'start' | 'wake' | 'github';
  message?: string;
  hint?: string;
}

const TITLES: Record<NonNullable<SandboxErrorData['phase']>, string> = {
  setup: 'The sandbox could not be prepared',
  start: 'The agent could not start in the sandbox',
  wake: 'The sandbox could not be resumed',
  github: 'GitHub is not available in this sandbox',
};

function parseData(data: ThreadEvent['data']): SandboxErrorData {
  if (typeof data !== 'string') return (data ?? {}) as SandboxErrorData;
  try {
    return JSON.parse(data) as SandboxErrorData;
  } catch {
    return {};
  }
}

export const SandboxErrorCard = memo(function SandboxErrorCard({ event }: { event: ThreadEvent }) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  const data = parseData(event.data);

  return (
    <div
      className="border-destructive/40 bg-destructive/5 space-y-1 rounded-lg border px-3 py-2 text-xs"
      data-testid={`sandbox-error-card-${event.id}`}
    >
      <div className="flex items-center gap-2">
        <CircleX className="text-destructive icon-sm shrink-0" />
        <span className="text-destructive font-medium">
          {TITLES[data.phase ?? 'setup'] ?? TITLES.setup}
        </span>
        {event.createdAt && (
          <span className="thread-timestamp text-muted-foreground/50 ml-auto">
            {timeAgo(event.createdAt, t, now)}
          </span>
        )}
      </div>
      {data.message && <p className="text-foreground whitespace-pre-wrap">{data.message}</p>}
      {data.hint && <p className="text-muted-foreground whitespace-pre-wrap">{data.hint}</p>}
    </div>
  );
});
