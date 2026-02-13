import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Terminal } from 'lucide-react';
import AnsiToHtml from 'ansi-to-html';
import { cn } from '@/lib/utils';

export function BashCard({ parsed, output, hideLabel }: { parsed: Record<string, unknown>; output?: string; hideLabel?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const command = parsed.command as string | undefined;
  const ansiConverter = useMemo(() => new AnsiToHtml({ fg: '#a1a1aa', bg: 'transparent', newline: false, escapeXML: true }), []);
  const htmlOutput = useMemo(() => output ? ansiConverter.toHtml(output) : null, [ansiConverter, output]);

  return (
    <div className="text-sm max-w-full overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-accent/30 transition-colors rounded-md overflow-hidden"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        {!hideLabel && <Terminal className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
        {!hideLabel && <span className="font-medium font-mono text-foreground flex-shrink-0">{t('tools.runCommand')}</span>}
        {!expanded && command && (
          <span className="text-muted-foreground truncate font-mono text-xs min-w-0 flex-1">
            {command}
          </span>
        )}
      </button>
      {expanded && command && (
        <div className="border-t border-border/40 overflow-hidden px-3 py-2 space-y-2">
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">{t('tools.input')}</div>
            <div className="rounded bg-background/80 border border-border/40 px-2.5 py-1.5 font-mono text-sm overflow-x-auto">
              <pre className="whitespace-pre-wrap break-all text-foreground leading-relaxed">{command}</pre>
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">{t('tools.output')}</div>
            {htmlOutput ? (
              <div className="rounded bg-background/80 border border-border/40 px-2.5 py-1.5 overflow-x-auto max-h-60 overflow-y-auto">
                <pre
                  className="font-mono text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap break-all"
                  dangerouslySetInnerHTML={{ __html: htmlOutput }}
                />
              </div>
            ) : (
              <div className="text-sm text-muted-foreground/50 italic py-1">
                {t('tools.waitingForOutput')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
