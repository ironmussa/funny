import type { WSTestActionData } from '@funny/shared';
import { useMemo } from 'react';

import {
  type OutputLine,
  useFollowScroll,
  withStableOccurrenceKeys,
} from '@/components/test-runner/detail-tabs/shared';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

/** Regex to match Playwright action lines from --reporter=line output */
const PLAYWRIGHT_SNIPPETS = [
  'page.goto',
  'page.click',
  'page.fill',
  'page.type',
  'page.press',
  'page.waitFor',
  'locator.',
  'expect(',
  'navigating to',
  'waiting for',
];
const ACTION_PATTERN =
  /^(\s*)(\d+\s+\|)?\s*(page\.|locator\.|expect\(|await\s+(?:page|locator|expect))/;
const STEP_PATTERN = /^(\s*)(›|→|⮕|➤|\d+\))\s+(.+)/;

interface ActionEntry {
  text: string;
  timestamp: number;
  isError: boolean;
}

export function CallTab({
  outputLines,
  structuredActions,
}: {
  outputLines: OutputLine[];
  structuredActions?: WSTestActionData[];
}) {
  // Use structured actions if available, else fall back to regex parsing
  const hasStructured = structuredActions && structuredActions.length > 0;

  // Extract Playwright action-like lines from output (fallback)
  const parsedActions = useMemo(() => {
    if (hasStructured) return [];
    const result: ActionEntry[] = [];
    for (const line of outputLines) {
      const text = line.line.trim();
      if (!text) continue;
      if (
        ACTION_PATTERN.test(text) ||
        STEP_PATTERN.test(text) ||
        PLAYWRIGHT_SNIPPETS.some((s) => text.includes(s)) ||
        /^\s*\d+\s*\|/.test(text)
      ) {
        result.push({
          text,
          timestamp: line.timestamp,
          isError: line.stream === 'stderr',
        });
      }
    }
    return result;
  }, [outputLines, hasStructured]);

  const itemCount = hasStructured ? structuredActions!.length : parsedActions.length;

  const { ref, handleScroll } = useFollowScroll(itemCount);

  if (itemCount === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Playwright actions will appear here during test execution…
      </div>
    );
  }

  return (
    <ScrollArea
      viewportRef={ref}
      viewportProps={{ onScroll: handleScroll }}
      className="h-full font-mono text-xs"
    >
      {hasStructured ? (
        <div>
          {structuredActions!.map((action) => (
            <div
              key={action.id}
              className={cn(
                'border-b border-border/20 px-3 py-1',
                action.error && 'text-destructive',
              )}
              data-testid={`call-action-${action.id}`}
            >
              <span className="text-muted-foreground">
                {action.category === 'expect' ? '✓ ' : '● '}
              </span>
              {action.title}
              {action.duration != null && (
                <span className="text-muted-foreground ml-2">
                  {action.duration < 1000
                    ? `${Math.round(action.duration)}ms`
                    : `${(action.duration / 1000).toFixed(1)}s`}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div>
          {withStableOccurrenceKeys(
            parsedActions,
            ({ isError, text, timestamp }) => `${timestamp}\u0000${isError}\u0000${text}`,
          ).map(({ key, value: action }) => (
            <div
              key={key}
              className={cn(
                'border-b border-border/20 px-3 py-1',
                action.isError && 'text-destructive',
              )}
            >
              {action.text}
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
