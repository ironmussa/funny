import { useMemo } from 'react';

import type { OutputLine } from '@/components/test-runner/detail-tabs/shared';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Annotation {
  type: string;
  description: string;
}

export function AnnotationsTab({ outputLines }: { outputLines: OutputLine[] }) {
  // Extract annotations from Playwright output
  // Playwright reporter=line prints annotations like:
  //   - @tag, @slow, @fixme, @skip, @fail, test.info().annotations
  const annotations = useMemo(() => {
    const result: Annotation[] = [];
    const seen = new Set<string>();
    for (const line of outputLines) {
      const text = line.line.trim();
      // Match annotation tags: @slow, @fixme, @skip, @fail, etc.
      const tagMatches = text.matchAll(/@(\w+)(?:\s*[:(]\s*(.+?)\s*[):]?)?/g);
      for (const match of tagMatches) {
        const key = `${match[1]}:${match[2] ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ type: match[1], description: match[2] ?? '' });
        }
      }
      // Match "annotation:" or "Annotation:" lines
      const annoMatch = text.match(/^\s*(?:annotation|tag)\s*:\s*(.+)/i);
      if (annoMatch) {
        const key = `anno:${annoMatch[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ type: 'annotation', description: annoMatch[1] });
        }
      }
    }
    return result;
  }, [outputLines]);

  return (
    <ScrollArea className="h-full text-xs">
      {annotations.length === 0 ? (
        <EmptyState title="No annotations found" />
      ) : (
        <div>
          {annotations.map((anno) => (
            <div
              key={`${anno.type}\u0000${anno.description}`}
              className="border-border/30 flex items-start gap-2 border-b px-3 py-1.5"
            >
              <Badge size="xxs" variant="outline" className="shrink-0">
                @{anno.type}
              </Badge>
              {anno.description && (
                <span className="text-muted-foreground">{anno.description}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
