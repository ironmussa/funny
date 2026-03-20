import { Check, Copy } from 'lucide-react';
import { lazy, Suspense, useState, useEffect } from 'react';
import remarkGfm from 'remark-gfm';

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useShiki } from '@/hooks/use-shiki';

import { cn } from './utils';

export const remarkPlugins = [remarkGfm];

const MARKDOWN_LANGS = new Set(['markdown', 'md']);

/**
 * Heuristic: does this text look like markdown content rather than code?
 * Checks for headings, bold/italic, and bullet/numbered lists.
 */
function looksLikeMarkdown(text: string): boolean {
  const lines = text.split('\n');
  let markdownSignals = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^#{1,6}\s/.test(trimmed)) markdownSignals++; // headings
    if (/\*\*[^*]+\*\*/.test(trimmed)) markdownSignals++; // bold
    if (/^[-*]\s/.test(trimmed)) markdownSignals++; // unordered list
    if (/^\d+\.\s/.test(trimmed)) markdownSignals++; // ordered list
  }
  return markdownSignals >= 3;
}

// Lazy-loaded nested markdown renderer for ```markdown code blocks
const LazyNestedMarkdown = lazy(() =>
  import('react-markdown').then(({ default: ReactMarkdown }) => ({
    default: function NestedMarkdown({ content }: { content: string }) {
      return (
        <ReactMarkdown remarkPlugins={remarkPlugins} components={baseMarkdownComponents}>
          {content}
        </ReactMarkdown>
      );
    },
  })),
);

function CopyButton({ text }: { text: string }) {
  const [copied, copy] = useCopyToClipboard();

  return (
    <button
      data-testid="code-block-copy"
      onClick={() => copy(text)}
      className="absolute right-2 top-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background/50 hover:text-foreground group-hover/codeblock:opacity-100"
      aria-label="Copy code"
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

function extractText(node: any): string {
  if (typeof node === 'string') return node;
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node.props?.children) return extractText(node.props.children);
  return '';
}

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const { highlight, ready } = useShiki();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !code) return;
    let cancelled = false;
    highlight(code, language).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, ready, highlight]);

  if (html) {
    return (
      <code
        className="block overflow-x-auto font-mono text-xs [&_.shiki]:m-0 [&_.shiki]:!bg-transparent [&_.shiki]:p-0 [&_.shiki_code_.line]:leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <code className={cn('block bg-muted p-2 rounded text-xs font-mono overflow-x-auto')}>
      {code}
    </code>
  );
}

export const baseMarkdownComponents = {
  code: ({ className, children, ...props }: any) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      const language = className.replace('language-', '');
      // Markdown blocks are rendered by the pre handler, just pass children through
      if (MARKDOWN_LANGS.has(language)) return <>{children}</>;
      const code = extractText(children).replace(/\n$/, '');
      return <HighlightedCode code={code} language={language} />;
    }
    return (
      <code className="rounded bg-muted-foreground/35 px-1 py-0.5 font-mono text-xs" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }: any) => {
    const text = extractText(children).replace(/\n$/, '');
    const langClass = children?.props?.className;
    const language = langClass?.startsWith('language-') ? langClass.replace('language-', '') : null;

    const isMarkdown =
      (language && MARKDOWN_LANGS.has(language)) || (!language && looksLikeMarkdown(text));

    if (isMarkdown) {
      return (
        <div className="prose prose-sm my-2 max-w-none rounded border border-border bg-muted/30 p-4">
          <Suspense fallback={<div className="whitespace-pre-wrap text-sm">{text}</div>}>
            <LazyNestedMarkdown content={text} />
          </Suspense>
        </div>
      );
    }

    return (
      <pre className="group/codeblock relative my-2 overflow-x-auto rounded bg-muted p-2 font-mono">
        {language && (
          <div className="mb-1 select-none text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {language}
          </div>
        )}
        {children}
        <CopyButton text={text} />
      </pre>
    );
  },
};
