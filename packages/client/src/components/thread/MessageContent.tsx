import { Check, Copy } from 'lucide-react';
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { toEditorUriWithLine, openFileInEditor } from '@/lib/editor-utils';
import {
  remarkPlugins,
  baseMarkdownComponents,
  markdownProseClassName,
} from '@/lib/markdown-components';
import { getMarkdownFileLinkPath, resolveMarkdownFilePath } from '@/lib/markdown-file-links';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore, editorLabels } from '@/stores/settings-store';

function getActiveFileBasePath(): string | null {
  const { activeThread, projects, selectedProjectId } = useAppStore.getState();
  const projectId = activeThread?.projectId ?? selectedProjectId;
  const projectPath = projectId ? projects.find((p) => p.id === projectId)?.path : null;
  return activeThread?.worktreePath || projectPath || null;
}

// Stable markdown component overrides — hoisted to module scope so ReactMarkdown
// sees the same component identity across renders (avoids unmount/remount of <a>).
// The `a` renderer reads the settings store imperatively, so no hooks are needed.
const markdownComponents = {
  ...baseMarkdownComponents,
  a: ({ href, children }: any) => {
    const text = String(children);
    const isWebUrl = href && /^https?:\/\//.test(href);
    const filePath = !isWebUrl ? getMarkdownFileLinkPath(href, text) : null;
    if (filePath) {
      const { defaultEditor, useInternalEditor } = useSettingsStore.getState();
      const resolvedPath = resolveMarkdownFilePath(filePath, getActiveFileBasePath());
      const uri = toEditorUriWithLine(resolvedPath, defaultEditor);
      const label = useInternalEditor ? 'internal editor' : editorLabels[defaultEditor];
      const tooltipText = `Open in ${label}: ${resolvedPath}`;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            {uri ? (
              <a href={uri} className="hover:underline">
                {children}
              </a>
            ) : (
              <button
                type="button"
                onClick={() => openFileInEditor(resolvedPath, defaultEditor)}
                className="inline cursor-pointer hover:underline"
              >
                {children}
              </button>
            )}
          </TooltipTrigger>
          <TooltipContent>{tooltipText}</TooltipContent>
        </Tooltip>
      );
    }
    return (
      <a href={href} className="hover:underline" target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

// Parse markdown in the first render instead of swapping a raw-text Suspense
// fallback for formatted HTML later. That swap changes headings, lists, and
// blockquote heights after paint, producing a visible thread-wide CLS cluster.
const rehypePlugins = [rehypeRaw, rehypeSanitize];

export const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  return (
    <div className={cn(markdownProseClassName, 'overflow-hidden')}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

export function CopyButton({ content }: { content: string }) {
  const [copied, copy] = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={() => copy(content)}
      className="msg-copy-btn text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 rounded p-1 opacity-0 transition-opacity group-hover/msg:opacity-100"
      aria-label="Copy message"
      data-testid="message-copy"
    >
      {copied ? <Check className="icon-sm" /> : <Copy className="icon-sm" />}
    </button>
  );
}
