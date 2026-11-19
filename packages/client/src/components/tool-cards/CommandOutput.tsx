import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { createAnsiConverter, hasAnsi } from '@/lib/ansi-to-html';

import { HighlightedCode } from './HighlightedCode';
import { isSearchCommand, parseSearchOutput, type SearchOutputBlock } from './search-output';

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
  return catMatch ? catMatch[1].toLowerCase() : null;
}

const SECTION_LABEL = 'text-muted-foreground mb-1 text-xs font-semibold uppercase';
const BOX = 'border-border/40 bg-background/80 overflow-x-auto rounded border px-2.5 py-1.5';
const MATCH_ROW = 'grid grid-cols-[auto_1fr] gap-x-2 font-mono text-xs leading-relaxed';

/** `rg` / `grep` output grouped by file: the path, then each line number and text. */
function SearchResults({ blocks }: { blocks: SearchOutputBlock[] }) {
  return (
    <div className="space-y-1.5" data-testid="command-output-search">
      {blocks.map((block, i) => {
        if (block.kind === 'note') {
          return (
            <div key={i} className="text-muted-foreground/60 font-mono text-xs italic">
              {block.text}
            </div>
          );
        }
        return (
          <div key={i}>
            {block.kind === 'file' && (
              <div className="text-foreground font-mono text-xs font-medium break-all">
                {block.path}
              </div>
            )}
            {block.matches.map((match, j) => (
              <div key={j} className={MATCH_ROW}>
                <span className="text-muted-foreground/60 min-w-[3ch] text-right tabular-nums">
                  {match.line}
                </span>
                <span className="text-muted-foreground break-all whitespace-pre-wrap">
                  {match.text}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const OUTPUT_PRE =
  'text-muted-foreground font-mono text-xs leading-relaxed break-all whitespace-pre-wrap';

/**
 * A shell command highlighted as bash, and its output: ANSI colors when the
 * output has them, otherwise highlighted in the language the command implies
 * (`git diff` → diff, `cat x.ts` → typescript), otherwise plain.
 */
export function CommandOutput({ command, output }: { command: string; output?: string }) {
  const { t } = useTranslation();
  // Security M6: `createAnsiConverter` enforces escapeXML regardless of caller.
  const ansiConverter = useMemo(
    () => createAnsiConverter({ fg: '#a1a1aa', bg: 'transparent', newline: false }),
    [],
  );
  const colored = useMemo(() => (output ? hasAnsi(output) : false), [output]);
  const htmlOutput = useMemo(
    () => (output && colored ? ansiConverter.toHtml(output) : null),
    [ansiConverter, output, colored],
  );
  const outputLang = useMemo(
    () => (output && !colored ? detectOutputLang(command) : null),
    [command, output, colored],
  );
  const searchBlocks = useMemo(
    () => (output && !colored && isSearchCommand(command) ? parseSearchOutput(output) : null),
    [command, output, colored],
  );

  return (
    <div className="space-y-2 py-2">
      <div className="px-3">
        <div className={SECTION_LABEL}>{t('tools.input')}</div>
        <div className={BOX}>
          <HighlightedCode code={command} language="bash" className="text-foreground" />
        </div>
      </div>

      <div className="px-3">
        <div className={SECTION_LABEL}>{t('tools.output')}</div>
        {output ? (
          <div className={BOX}>
            {htmlOutput ? (
              <pre className={OUTPUT_PRE} dangerouslySetInnerHTML={{ __html: htmlOutput }} />
            ) : searchBlocks ? (
              <SearchResults blocks={searchBlocks} />
            ) : (
              <HighlightedCode
                code={output}
                language={outputLang}
                className="text-muted-foreground"
              />
            )}
          </div>
        ) : (
          <div className="text-muted-foreground/50 py-1 text-sm italic">
            {t('tools.waitingForOutput')}
          </div>
        )}
      </div>
    </div>
  );
}
