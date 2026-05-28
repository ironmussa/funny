import { Check, Copy } from 'lucide-react';
import { memo, lazy, Suspense } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { toEditorUriWithLine, openFileInEditor } from '@/lib/editor-utils';
import { remarkPlugins, baseMarkdownComponents } from '@/lib/markdown-components';
import { useSettingsStore, editorLabels } from '@/stores/settings-store';

// Regex to match file paths like /foo/bar.ts, C:\foo\bar.ts, or file_path:line_number patterns
const FILE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s:*?"<>|,()]+(?::\d+)?/g;

// Stable markdown component overrides — hoisted to module scope so ReactMarkdown
// sees the same component identity across renders (avoids unmount/remount of <a>).
// The `a` renderer reads the settings store imperatively, so no hooks are needed.
const markdownComponents = {
  ...baseMarkdownComponents,
  a: ({ href, children }: any) => {
    const text = String(children);
    const isWebUrl = href && /^https?:\/\//.test(href);
    const fileMatch = !isWebUrl && text.match(FILE_PATH_RE);
    if (fileMatch) {
      const { defaultEditor, useInternalEditor } = useSettingsStore.getState();
      const uri = toEditorUriWithLine(fileMatch[0], defaultEditor);
      const label = useInternalEditor ? 'internal editor' : editorLabels[defaultEditor];
      const tooltipText = `Open in ${label}: ${text}`;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            {uri ? (
              <a href={uri} className="hover:underline">
                {children}
              </a>
            ) : (
              <button
                onClick={() => openFileInEditor(fileMatch[0], defaultEditor)}
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

// Prefetch react-markdown immediately at module load time.
// By the time ThreadView renders messages, the chunk is already downloaded.
const _markdownImport = import('react-markdown');

// Lazy-load `rehype-sanitize` alongside react-markdown. Security L1: every
// ReactMarkdown invocation in the app MUST pass this plugin so that an LLM
// (or anything else upstream) cannot smuggle raw HTML — including <script>,
// <iframe>, or event handlers — through the renderer.
const _rehypeSanitizeImport = import('rehype-sanitize');

const LazyMarkdownRenderer = lazy(() =>
  Promise.all([_markdownImport, _rehypeSanitizeImport]).then(
    ([{ default: ReactMarkdown }, { default: rehypeSanitize }]) => {
      const rehypePlugins = [rehypeSanitize];
      function MarkdownRenderer({ content }: { content: string }) {
        return (
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={markdownComponents}
          >
            {content}
          </ReactMarkdown>
        );
      }
      return { default: MarkdownRenderer };
    },
  ),
);

export const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none overflow-hidden">
      <Suspense
        fallback={
          <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm">{content}</div>
        }
      >
        <LazyMarkdownRenderer content={content} />
      </Suspense>
    </div>
  );
});

export function CopyButton({ content }: { content: string }) {
  const [copied, copy] = useCopyToClipboard();

  return (
    <button
      onClick={() => copy(content)}
      className="msg-copy-btn shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/msg:opacity-100"
      aria-label="Copy message"
      data-testid="message-copy"
    >
      {copied ? <Check className="icon-sm" /> : <Copy className="icon-sm" />}
    </button>
  );
}
