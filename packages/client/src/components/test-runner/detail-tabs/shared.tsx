import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface OutputLine {
  line: string;
  stream: 'stdout' | 'stderr';
  timestamp: number;
}

export function formatDuration(ms: number | undefined): string {
  if (ms == null) return '-';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatSize(bytes: number | undefined): string {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function withStableOccurrenceKeys<T>(
  items: T[],
  getIdentity: (item: T) => string,
): Array<{ key: string; value: T }> {
  const occurrences = new Map<string, number>();
  return items.map((value) => {
    const identity = getIdentity(value);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { key: `${identity}\u0000${occurrence}`, value };
  });
}

export function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function DetailTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent variant="mono">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Keeps a scroll viewport pinned to the bottom as items arrive, until the
 * user scrolls up more than 40px.
 */
export function useFollowScroll(itemCount: number) {
  const ref = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  useEffect(() => {
    if (!ref.current || userScrolled.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [itemCount]);

  const handleScroll = () => {
    if (!ref.current) return;
    const { scrollTop, scrollHeight, clientHeight } = ref.current;
    userScrolled.current = scrollHeight - scrollTop - clientHeight > 40;
  };

  return { ref, handleScroll };
}
