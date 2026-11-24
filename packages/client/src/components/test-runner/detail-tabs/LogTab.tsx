import { useEffect, useMemo, useState } from 'react';

import {
  type OutputLine,
  useFollowScroll,
  withStableOccurrenceKeys,
} from '@/components/test-runner/detail-tabs/shared';
import { ScrollArea } from '@/components/ui/scroll-area';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { cn } from '@/lib/utils';

/** The theme colors ANSI output is drawn with, read again after a theme switch. */
function readAnsiColors(): { fg: string; bg: string } {
  return { fg: getCssVar('--foreground'), bg: getCssVar('--background') };
}

function getCssVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : '#1b1b1b';
}

export function LogTab({ outputLines }: { outputLines: OutputLine[] }) {
  // Observe the <html> class attribute to detect theme changes so the ANSI
  // converter re-creates with fresh CSS variable values after a theme switch.
  const [ansiColors, setAnsiColors] = useState(readAnsiColors);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setAnsiColors(readAnsiColors());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const ansiConverter = useMemo(
    () => createAnsiConverter({ ...ansiColors, newline: false }),
    [ansiColors],
  );
  const keyedOutputLines = useMemo(
    () =>
      withStableOccurrenceKeys(
        outputLines,
        ({ line, stream, timestamp }) => `${timestamp}\u0000${stream}\u0000${line}`,
      ),
    [outputLines],
  );

  const { ref: logRef, handleScroll } = useFollowScroll(outputLines.length);

  return (
    <ScrollArea
      viewportRef={logRef}
      viewportProps={{ onScroll: handleScroll }}
      className="h-full font-mono text-xs"
    >
      {outputLines.length === 0 ? (
        <div className="text-muted-foreground flex h-full items-center justify-center">
          Test output will appear here…
        </div>
      ) : (
        <pre className="text-foreground px-3 py-1 leading-relaxed wrap-break-word whitespace-pre-wrap">
          {keyedOutputLines.map(({ key, value: line }) => (
            <div
              key={key}
              className={cn(line.stream === 'stderr' ? 'text-destructive' : '')}
              dangerouslySetInnerHTML={{ __html: ansiConverter.toHtml(line.line) }}
            />
          ))}
        </pre>
      )}
    </ScrollArea>
  );
}
