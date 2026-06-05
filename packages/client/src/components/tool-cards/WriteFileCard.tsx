import { Check, ChevronRight, Copy, Eye, FileText, FileCode2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MessageContent } from '@/components/thread/MessageContent';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { ensureLanguage, extToHljsLang, highlightCode } from '@/hooks/use-highlight';
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

export function WriteFileCard({
  parsed,
  hideLabel,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  hideLabel?: boolean;
  displayTime?: string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const filePath = parsed.file_path as string | undefined;
  const projectPath = useCurrentProjectPath();
  const displayPath = filePath ? makeRelativePath(filePath, projectPath) : undefined;
  const content = parsed.content as string | undefined;
  const ext = filePath ? getFileExtension(filePath).toLowerCase() : '';
  const fileName = filePath ? getFileName(filePath) : 'unknown';
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const [renderMarkdown, setRenderMarkdown] = useState(isMarkdown);
  const [copied, copy] = useCopyToClipboard();

  const hljsLang = ext ? extToHljsLang(ext) : 'plaintext';
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    if (content == null || !hljsLang || hljsLang === 'plaintext') {
      setHighlighted(null);
      return;
    }
    let cancelled = false;
    ensureLanguage(hljsLang).then(() => {
      if (!cancelled) setHighlighted(highlightCode(content, hljsLang));
    });
    return () => {
      cancelled = true;
    };
  }, [content, hljsLang]);

  return (
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-accent/30 flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors"
      >
        <ChevronRight
          className={cn(
            'icon-xs shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {!hideLabel && <FileText className="icon-xs text-muted-foreground shrink-0" />}
        {!hideLabel && (
          <span className="text-foreground shrink-0 font-mono font-medium">
            {t('tools.writeFile')}
          </span>
        )}
        {filePath &&
          (() => {
            const editorUri = toEditorUri(filePath, defaultEditor);
            const editorTitle = t('tools.openInEditor', {
              editor: getEditorLabel(defaultEditor),
              path: filePath,
            });
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  {editorUri ? (
                    <a
                      href={editorUri}
                      onClick={(e) => e.stopPropagation()}
                      className="text-muted-foreground hover:text-primary min-w-0 truncate font-mono text-xs hover:underline"
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
                          openFileInEditor(filePath, defaultEditor);
                        }
                      }}
                      className="text-muted-foreground hover:text-primary min-w-0 cursor-pointer truncate text-left font-mono text-xs hover:underline"
                    >
                      {displayPath}
                    </span>
                  )}
                </TooltipTrigger>
                <TooltipContent>{editorTitle}</TooltipContent>
              </Tooltip>
            );
          })()}
        {displayTime && (
          <span className="text-muted-foreground/50 ml-auto shrink-0 text-[10px] tabular-nums">
            {displayTime}
          </span>
        )}
      </button>
      {expanded && content != null && (
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
                      onClick={() => setRenderMarkdown((v) => !v)}
                      data-testid="write-file-toggle-markdown"
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
                    onClick={() => copy(content)}
                    data-testid="write-file-copy"
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
                <MessageContent content={content} />
              </div>
            ) : highlighted ? (
              <pre className="code-viewer text-foreground/80 px-3 py-2 font-mono text-sm leading-relaxed break-all whitespace-pre-wrap">
                <code
                  className={`hljs language-${hljsLang}`}
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              </pre>
            ) : (
              <pre className="text-foreground/80 px-3 py-2 font-mono text-sm leading-relaxed break-all whitespace-pre-wrap">
                {content}
              </pre>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
