import { Check, ChevronRight, Copy, Eye, FileCode2, FileSearch } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MessageContent } from '@/components/thread/MessageContent';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
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

/**
 * Strip the "   12→" line-number prefix that the Read tool prepends to each line.
 */
function stripLinePrefix(raw: string): string {
  return raw.replace(/^\s*\d+[→\t]/gm, '');
}

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

  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border text-sm">
      <button
        type="button"
        onClick={() => hasOutput && setExpanded(!expanded)}
        disabled={!hasOutput}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs',
          hasOutput && 'cursor-pointer transition-colors hover:bg-accent/30',
          !hasOutput && 'cursor-default',
        )}
      >
        {hasOutput ? (
          <ChevronRight
            className={cn(
              'icon-xs flex-shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="icon-xs flex-shrink-0" />
        )}
        {!hideLabel && <FileSearch className="icon-xs flex-shrink-0 text-muted-foreground" />}
        {!hideLabel && (
          <span className="flex-shrink-0 font-mono font-medium text-foreground">
            {t('tools.readFile')}
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
                      className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
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
                      className="min-w-0 cursor-pointer truncate text-left font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
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
          <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
            {displayTime}
          </span>
        )}
      </button>
      {expanded && hasOutput && (
        <ScrollArea className="max-h-[50vh] border-t border-border/40">
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border/30 bg-background px-3 py-1 backdrop-blur-sm">
            <span className="truncate text-xs font-medium text-muted-foreground">{fileName}</span>
            <div className="flex flex-shrink-0 items-center gap-1">
              {ext && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
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
                    onClick={() => copy(cleanContent)}
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
              <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-sm leading-relaxed text-foreground/80">
                {output}
              </pre>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
