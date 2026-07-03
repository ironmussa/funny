import { ChevronRight, Terminal } from 'lucide-react';
import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '@/components/ui/scroll-area';
import { ensureLanguage, highlightCode } from '@/hooks/use-highlight';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { cn } from '@/lib/utils';

// eslint-disable-next-line no-control-regex -- ESC is the literal ANSI CSI marker we're detecting
const ANSI_ESC_RE = /\x1b\[/;

function commandToText(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (command == null) return null;
  if (typeof command === 'number' || typeof command === 'boolean' || typeof command === 'bigint') {
    return String(command);
  }

  try {
    return JSON.stringify(command, null, 2) ?? String(command);
  } catch {
    return String(command);
  }
}

/**
 * Pick a syntax-highlighting language for command output based on the command
 * itself. Conservative: returns null when we can't be confident, so we don't
 * mis-tokenize plain text.
 */
function detectOutputLang(command: string): string | null {
  const cmd = command.trim();
  if (/(^|[\s;&|])(bunx\s+)?tsc(\s|$)/.test(cmd)) return 'typescript';
  if (/(^|[\s;&|])bun\s+--check(\s|$)/.test(cmd)) return 'typescript';
  if (/(^|[\s;&|])git\s+(diff|show|log\s+-p|format-patch)(\s|$)/.test(cmd)) return 'diff';
  if (/(^|[\s;&|])(diff|patch)(\s|$)/.test(cmd)) return 'diff';
  if (/(^|[\s;&|])jq(\s|$)/.test(cmd)) return 'json';
  const catMatch = cmd.match(
    /(?:^|[\s;&|])(?:cat|head|tail|less|more|bat)\s+[^|;&]*?\.([a-zA-Z0-9]+)(?:\s|$|[|;&])/,
  );
  if (catMatch) {
    const ext = catMatch[1].toLowerCase();
    return ext;
  }
  return null;
}

export function BashCard({
  parsed,
  output,
  author,
  hideLabel,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  author?: string;
  hideLabel?: boolean;
  displayTime?: string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(author === 'shell');
  const command = useMemo(() => commandToText(parsed.command), [parsed.command]);
  // Security M6: `createAnsiConverter` enforces escapeXML regardless of caller.
  const ansiConverter = useMemo(
    () => createAnsiConverter({ fg: '#a1a1aa', bg: 'transparent', newline: false }),
    [],
  );
  const hasAnsi = useMemo(() => (output ? ANSI_ESC_RE.test(output) : false), [output]);
  const htmlOutput = useMemo(
    () => (output && hasAnsi ? ansiConverter.toHtml(output) : null),
    [ansiConverter, output, hasAnsi],
  );
  const outputLang = useMemo(
    () => (command && output && !hasAnsi ? detectOutputLang(command) : null),
    [command, output, hasAnsi],
  );
  const [highlightedCommand, setHighlightedCommand] = useState<{
    command: string;
    html: string;
  } | null>(null);
  const [highlightedOutput, setHighlightedOutput] = useState<{
    output: string;
    lang: string;
    html: string;
  } | null>(null);

  useEffect(() => {
    if (!expanded || !command) return;
    let cancelled = false;
    ensureLanguage('bash').then((ok) => {
      if (cancelled || !ok) return;
      setHighlightedCommand({ command, html: highlightCode(command, 'bash') });
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, command]);

  useEffect(() => {
    if (!expanded || !output || !outputLang) return;
    let cancelled = false;
    ensureLanguage(outputLang).then((ok) => {
      if (cancelled || !ok) return;
      setHighlightedOutput({ output, lang: outputLang, html: highlightCode(output, outputLang) });
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, output, outputLang]);

  return (
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-accent/30 flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs"
      >
        <ChevronRight
          className={cn('icon-xs shrink-0 text-muted-foreground', expanded && 'rotate-90')}
        />
        {!hideLabel && <Terminal className="icon-xs text-muted-foreground shrink-0" />}
        {!hideLabel && (
          <span className="text-foreground shrink-0 font-mono font-medium">
            {t('tools.runCommand')}
          </span>
        )}
        {!expanded && command && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
            {command}
          </span>
        )}
        {displayTime && (
          <span className="text-muted-foreground/50 ml-auto shrink-0 text-[10px] tabular-nums">
            {displayTime}
          </span>
        )}
      </button>
      {expanded && command && (
        <ScrollArea
          className="border-border/40 border-t"
          viewportProps={{ className: 'max-h-[50vh] scroll-fade-none' }}
        >
          <div className="space-y-2 py-2">
            <div className="px-3">
              <div className="text-muted-foreground mb-1 text-xs font-semibold uppercase">
                {t('tools.input')}
              </div>
              <div className="border-border/40 bg-background/80 overflow-x-auto rounded border px-2.5 py-1.5 font-mono text-xs">
                {highlightedCommand?.command === command ? (
                  <pre className="code-viewer hljs text-foreground m-0 leading-relaxed break-all whitespace-pre-wrap">
                    <code
                      className="hljs language-bash"
                      dangerouslySetInnerHTML={{ __html: highlightedCommand.html }}
                    />
                  </pre>
                ) : (
                  <pre className="text-foreground leading-relaxed break-all whitespace-pre-wrap">
                    {command}
                  </pre>
                )}
              </div>
            </div>

            <div className="px-3">
              <div className="text-muted-foreground mb-1 text-xs font-semibold uppercase">
                {t('tools.output')}
              </div>
              {output ? (
                <div className="border-border/40 bg-background/80 rounded border px-2.5 py-1.5">
                  {highlightedOutput?.output === output && highlightedOutput.lang === outputLang ? (
                    <pre className="code-viewer text-muted-foreground m-0 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                      <code
                        className="hljs"
                        dangerouslySetInnerHTML={{ __html: highlightedOutput.html }}
                      />
                    </pre>
                  ) : htmlOutput ? (
                    <pre
                      className="text-muted-foreground font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
                      dangerouslySetInnerHTML={{ __html: htmlOutput }}
                    />
                  ) : (
                    <pre className="text-muted-foreground font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                      {output}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="text-muted-foreground/50 py-1 text-sm italic">
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
