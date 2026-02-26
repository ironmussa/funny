import AnsiToHtml from 'ansi-to-html';
import { ChevronRight, Terminal } from 'lucide-react';
import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useShiki } from '@/hooks/use-shiki';
import { cn } from '@/lib/utils';

export function BashCard({
  parsed,
  output,
  hideLabel,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const command = parsed.command as string | undefined;
  // SECURITY: escapeXML must remain true to prevent XSS via dangerouslySetInnerHTML
  const ansiConverter = useMemo(
    () => new AnsiToHtml({ fg: '#a1a1aa', bg: 'transparent', newline: false, escapeXML: true }),
    [],
  );
  const htmlOutput = useMemo(
    () => (output ? ansiConverter.toHtml(output) : null),
    [ansiConverter, output],
  );
  const { highlight } = useShiki();
  const [highlightedCommand, setHighlightedCommand] = useState<string | null>(null);
  const [highlightedOutput, setHighlightedOutput] = useState<string | null>(null);

  useEffect(() => {
    if (expanded && command) {
      highlight(command, 'bash').then(setHighlightedCommand);
    }
  }, [expanded, command, highlight]);

  useEffect(() => {
    if (expanded && output) {
      highlight(output, 'bash').then(setHighlightedOutput);
    }
  }, [expanded, output, highlight]);

  return (
    <div className="max-w-full overflow-hidden text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/30"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {!hideLabel && <Terminal className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
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
      </button>
      {expanded && command && (
        <div className="space-y-2 overflow-hidden border-t border-border/40 px-3 py-2">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
              {t('tools.input')}
            </div>
            <div className="overflow-x-auto rounded border border-border/40 bg-background/80 px-2.5 py-1.5 font-mono text-sm">
              {highlightedCommand ? (
                <div
                  className="whitespace-pre-wrap break-all leading-relaxed [&_.shiki]:!bg-transparent [&_code]:!p-0 [&_pre]:!m-0"
                  dangerouslySetInnerHTML={{ __html: highlightedCommand }}
                />
              ) : (
                <pre className="whitespace-pre-wrap break-all leading-relaxed text-foreground">
                  {command}
                </pre>
              )}
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
              {t('tools.output')}
            </div>
            {output ? (
              <div className="max-h-60 overflow-hidden rounded border border-border/40 bg-background/80 px-2.5 py-1.5">
                {highlightedOutput ? (
                  <div
                    className="whitespace-pre-wrap break-all font-mono text-sm leading-relaxed [&_.shiki]:!bg-transparent [&_code]:!p-0 [&_pre]:!m-0"
                    dangerouslySetInnerHTML={{ __html: highlightedOutput }}
                  />
                ) : (
                  <pre
                    className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground"
                    dangerouslySetInnerHTML={{ __html: htmlOutput! }}
                  />
                )}
              </div>
            ) : (
              <div className="py-1 text-sm italic text-muted-foreground/50">
                {t('tools.waitingForOutput')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
