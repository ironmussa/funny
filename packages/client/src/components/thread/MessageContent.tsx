import { Check, Copy } from 'lucide-react';
import { memo, lazy, Suspense } from 'react';

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { toEditorUriWithLine, openFileInEditor } from '@/lib/editor-utils';
import { remarkPlugins, baseMarkdownComponents } from '@/lib/markdown-components';
import { useSettingsStore, editorLabels } from '@/stores/settings-store';

// Regex to match file paths like /foo/bar.ts, C:\foo\bar.ts, or file_path:line_number patterns
const FILE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s:*?"<>|,()]+(?::\d+)?/g;

// Prefetch react-markdown immediately at module load time.
// By the time ThreadView renders messages, the chunk is already downloaded.
const _markdownImport = import('react-markdown');

const LazyMarkdownRenderer = lazy(() =>
  _markdownImport.then(({ default: ReactMarkdown }) => {
    const markdownComponents = {
      ...baseMarkdownComponents,
      a: ({ href, children }: any) => {
        const text = String(children);
        const isWebUrl = href && /^https?:\/\//.test(href);
        const fileMatch = !isWebUrl && text.match(FILE_PATH_RE);
        if (fileMatch) {
          const editor = useSettingsStore.getState().defaultEditor;
          const uri = toEditorUriWithLine(fileMatch[0], editor);
          const label = editorLabels[editor];
          if (uri) {
            return (
              <a
                href={uri}
                className="text-primary hover:underline"
                title={`Open in ${label}: ${text}`}
              >
                {children}
              </a>
            );
          }
          return (
            <button
              onClick={() => openFileInEditor(fileMatch[0], editor)}
              className="inline cursor-pointer text-primary hover:underline"
              title={`Open in ${label}: ${text}`}
            >
              {children}
            </button>
          );
        }
        return (
          <a
            href={href}
            className="text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        );
      },
    };

    function MarkdownRenderer({ content }: { content: string }) {
      return (
        <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      );
    }
    return { default: MarkdownRenderer };
  }),
);

export const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none">
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
