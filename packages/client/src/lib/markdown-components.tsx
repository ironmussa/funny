import { Check, Copy } from 'lucide-react';
import { useState, useEffect } from 'react';
import remarkGfm from 'remark-gfm';

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useShiki } from '@/hooks/use-shiki';

import { cn } from './utils';

export const remarkPlugins = [remarkGfm];

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
      const code = extractText(children).replace(/\n$/, '');
      return <HighlightedCode code={code} language={language} />;
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }: any) => {
    const text = extractText(children).replace(/\n$/, '');
    const langClass = children?.props?.className;
    const language = langClass?.startsWith('language-') ? langClass.replace('language-', '') : null;
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
