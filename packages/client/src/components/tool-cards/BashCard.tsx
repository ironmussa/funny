import { ChevronRight, Terminal } from 'lucide-react';
import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '@/components/ui/scroll-area';
import { ensureLanguage, highlightCode } from '@/hooks/use-highlight';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { cn } from '@/lib/utils';

export function BashCard({
  parsed,
  output,
  hideLabel,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
  displayTime?: string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const command = parsed.command as string | undefined;
  // Security M6: `createAnsiConverter` enforces escapeXML regardless of caller.
  const ansiConverter = useMemo(
    () => createAnsiConverter({ fg: '#a1a1aa', bg: 'transparent', newline: false }),
    [],
  );
  const htmlOutput = useMemo(
    () => (output ? ansiConverter.toHtml(output) : null),
    [ansiConverter, output],
  );
  const [highlightedCommand, setHighlightedCommand] = useState<string | null>(null);

  useEffect(() => {
    if (expanded && command) {
      ensureLanguage('bash').then(() => {
        setHighlightedCommand(highlightCode(command, 'bash'));
      });
    }
  }, [expanded, command]);

  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/30"
      >
        <ChevronRight
          className={cn(
            'icon-xs flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {!hideLabel && <Terminal className="icon-xs flex-shrink-0 text-muted-foreground" />}
        {!hideLabel && (
          <span className="flex-shrink-0 font-mono font-medium text-foreground">
            {t('tools.runCommand')}
          </span>
        )}
        {!expanded && command && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {command}
          </span>
        )}
        {displayTime && (
          <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
            {displayTime}
          </span>
        )}
      </button>
      {expanded && command && (
        <ScrollArea className="max-h-[50vh] border-t border-border/40">
          <div className="space-y-2 py-2">
            <div className="px-3">
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                {t('tools.input')}
              </div>
              <div className="overflow-x-auto rounded border border-border/40 bg-background/80 px-2.5 py-1.5 font-mono text-xs">
                {highlightedCommand ? (
                  <div
                    className="hljs whitespace-pre-wrap break-all leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: highlightedCommand }}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-all leading-relaxed text-foreground">
                    {command}
                  </pre>
                )}
              </div>
            </div>

            <div className="px-3">
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                {t('tools.output')}
              </div>
              {output ? (
                <div className="rounded border border-border/40 bg-background/80 px-2.5 py-1.5">
                  <pre
                    className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground"
                    dangerouslySetInnerHTML={{ __html: htmlOutput! }}
                  />
                </div>
              ) : (
                <div className="py-1 text-sm italic text-muted-foreground/50">
                  {t('tools.waitingForOutput')}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
