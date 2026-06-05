import { Check, ChevronRight, Copy, Eye, FileCode2, FileSearch } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MessageContent } from '@/components/thread/MessageContent';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import {
  detectLanguageFromContent,
  ensureLanguage,
  filePathToHljsLang,
  highlightLine,
} from '@/hooks/use-highlight';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';

import {
  toEditorUri,
  openFileInEditor,
  getEditorLabel,
  getFileExtension,
  getFileName,
  useCurrentProjectPath,
  makeRelativePath,
} from './utils';

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);

const LINE_PREFIX_RE = /^(\s*)(\d+)([→\t])(.*)$/;

interface ParsedLine {
  num: string;
  content: string;
}

function parseLines(raw: string): ParsedLine[] {
  return raw.split('\n').map((line) => {
    const m = line.match(LINE_PREFIX_RE);
    if (m) return { num: m[2], content: m[4] };
    return { num: '', content: line };
  });
}

/**
 * Strip the "   12→" line-number prefix that the Read tool prepends to each line.
 */
function stripLinePrefix(raw: string): string {
  return raw.replace(/^\s*\d+[→\t]/gm, '');
}

function HighlightedFileContent({ content, filePath }: { content: string; filePath?: string }) {
  // With a path the extension picks the language; without one (e.g. Cursor's
  // ACP reads omit the path) fall back to detecting it from the content.
  const [lang, setLang] = useState<string>(() =>
    filePath ? filePathToHljsLang(filePath) : 'plaintext',
  );
  const [langReady, setLangReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLangReady(false);
    const resolveLangFor = filePath
      ? Promise.resolve(filePathToHljsLang(filePath))
      : detectLanguageFromContent(content);
    resolveLangFor.then(async (detected) => {
      if (cancelled) return;
      setLang(detected);
      const ok = await ensureLanguage(detected);
      if (!cancelled) setLangReady(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, content]);

  const lines = useMemo(() => parseLines(content), [content]);
  const numWidth = useMemo(() => {
    const max = lines.reduce((m, l) => Math.max(m, l.num.length), 0);
    return `${max}ch`;
  }, [lines]);

  return (
    <pre className="hljs code-viewer m-0 px-3 py-2 font-mono text-sm leading-relaxed whitespace-pre">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          {line.num ? (
            <span
              className="text-muted-foreground/60 mr-3 shrink-0 text-right select-none"
              style={{ width: numWidth }}
            >
              {line.num}
            </span>
          ) : null}
          <span
            className="min-w-0 flex-1"
            dangerouslySetInnerHTML={{
              __html: langReady
                ? highlightLine(line.content, lang) || '\u00A0'
                : escapeHtml(line.content) || '\u00A0',
            }}
          />
        </div>
      ))}
    </pre>
  );
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// eslint-disable-next-line max-lines-per-function -- collapsible card composes header + body + per-language async highlight; further extraction tracked separately
export function ReadFileCard({
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
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const filePath = parsed.file_path as string | undefined;
  const projectPath = useCurrentProjectPath();
  const displayPath = filePath ? makeRelativePath(filePath, projectPath) : undefined;
  const ext = filePath ? getFileExtension(filePath).toLowerCase() : '';
  const fileName = filePath ? getFileName(filePath) : 'unknown';
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const hasOutput = typeof output === 'string' && output.length > 0;

  const [expanded, setExpanded] = useState(false);
  const [renderMarkdown, setRenderMarkdown] = useState(isMarkdown);
  const [copied, copy] = useCopyToClipboard();

  const cleanContent = useMemo(
    () => (hasOutput ? stripLinePrefix(output!) : ''),
    [hasOutput, output],
  );

  const editorUri = filePath ? toEditorUri(filePath, defaultEditor) : null;
  const editorTitle = filePath
    ? t('tools.openInEditor', {
        editor: getEditorLabel(defaultEditor),
        path: filePath,
      })
    : '';

  const toggle = () => {
    if (hasOutput) setExpanded((v) => !v);
  };

  return (
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-sm">
      <div
        role={hasOutput ? 'button' : undefined}
        tabIndex={hasOutput ? 0 : undefined}
        aria-expanded={hasOutput ? expanded : undefined}
        onClick={toggle}
        onKeyDown={(e) => {
          if (!hasOutput) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        className={cn(
          'flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs',
          hasOutput && 'cursor-pointer transition-colors hover:bg-accent/30',
          !hasOutput && 'cursor-default',
        )}
      >
        {hasOutput ? (
          <ChevronRight
            className={cn(
              'icon-xs shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="icon-xs shrink-0" />
        )}
        {!hideLabel && <FileSearch className="icon-xs text-muted-foreground shrink-0" />}
        {!hideLabel && (
          <span className="text-foreground shrink-0 font-mono font-medium">
            {t('tools.readFile')}
          </span>
        )}
        {filePath && (
          <Tooltip>
            <TooltipTrigger asChild>
              {editorUri ? (
                <a
                  href={editorUri}
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-primary min-w-0 truncate font-mono text-xs hover:underline"
                  data-testid="read-file-open-link"
                >
                  {displayPath}
                </a>
              ) : (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    openFileInEditor(filePath, defaultEditor);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      e.preventDefault();
                      openFileInEditor(filePath, defaultEditor);
                    }
                  }}
                  className="text-muted-foreground hover:text-primary min-w-0 cursor-pointer truncate text-left font-mono text-xs hover:underline"
                  data-testid="read-file-open-link"
                >
                  {displayPath}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent>{editorTitle}</TooltipContent>
          </Tooltip>
        )}
        {displayTime && (
          <span className="text-muted-foreground/50 ml-auto shrink-0 text-[10px] tabular-nums">
            {displayTime}
          </span>
        )}
      </div>
      {expanded && hasOutput && (
        <ScrollArea
          className="border-border/40 border-t"
          viewportProps={{ className: 'max-h-[50vh]' }}
        >
          <div className="border-border/30 bg-background sticky top-0 z-10 flex items-center justify-between gap-2 border-b px-3 py-1 backdrop-blur-xs">
            <span className="text-muted-foreground truncate text-xs font-medium">{fileName}</span>
            <div className="flex shrink-0 items-center gap-1">
              {ext && (
                <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
                  {ext}
                </span>
              )}
              {isMarkdown && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenderMarkdown((v) => !v);
                      }}
                      data-testid="read-file-toggle-markdown"
                      aria-pressed={renderMarkdown}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {renderMarkdown ? (
                        <FileCode2 className="icon-sm" />
                      ) : (
                        <Eye className="icon-sm" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {renderMarkdown
                      ? t('tools.viewSource', 'View source')
                      : t('tools.preview', 'Preview')}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      copy(cleanContent);
                    }}
                    data-testid="read-file-copy"
                    aria-label={t('tools.copy', 'Copy')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {copied ? <Check className="icon-sm" /> : <Copy className="icon-sm" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{t('tools.copy', 'Copy')}</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div>
            {isMarkdown && renderMarkdown ? (
              <div className="px-3 py-2">
                <MessageContent content={cleanContent} />
              </div>
            ) : (
              <HighlightedFileContent content={output!} filePath={filePath} />
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
