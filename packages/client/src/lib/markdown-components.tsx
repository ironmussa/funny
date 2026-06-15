import { Check, Copy } from 'lucide-react';
import { lazy, Suspense, useState, useEffect } from 'react';
import remarkGfm from 'remark-gfm';

import { Checkbox } from '@/components/ui/checkbox';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { ensureLanguage, getFileExtension, highlightCode } from '@/hooks/use-highlight';
import { isExternalUrl } from '@/lib/raw-file-src';
import { useResolvedMediaSrc } from '@/lib/use-direct-media';
import { getVisualizerForFence, getVisualizerForFileExt } from '@/lib/visualizer-registry';
import { useMediaPreviewStore } from '@/stores/media-preview-store';

import { cn } from './utils';

export const remarkPlugins = [remarkGfm];

/**
 * Canonical wrapper class for EVERY markdown sink in the app.
 *
 * The actual styling lives in the hand-written `.prose` rules in `globals.css`
 * (themed via CSS variables — `@tailwindcss/typography` is NOT installed, so
 * `prose-sm` / `prose-xs` / `dark:prose-invert` / `prose-*:` modifiers are
 * no-ops). Use this constant instead of re-typing `prose ...` strings so every
 * markdown surface renders identically; layer genuine per-site extras (padding,
 * border, background, overflow) on top via `cn(markdownProseClassName, '...')`.
 */
export const markdownProseClassName = 'prose max-w-none';

const MARKDOWN_LANGS = new Set(['markdown', 'md']);

// Extensions a native <img> renders directly. Kept in sync with the image
// visualizer's `fileExtensions` in `visualizers/builtin.tsx`. Local images stay
// on the <img>+lightbox path below instead of deferring to the binary visualizer.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']);

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

// Lazy-loaded nested markdown renderer for ```markdown code blocks.
// Security ME-9: rehypeSanitize is mandatory on every ReactMarkdown sink
// (see MessageContent.tsx). Lazy-loaded alongside the markdown package so
// the bundle cost is shared.
const LazyNestedMarkdown = lazy(() =>
  Promise.all([import('react-markdown'), import('rehype-sanitize')]).then(
    ([{ default: ReactMarkdown }, { default: rehypeSanitize }]) => ({
      default: function NestedMarkdown({ content }: { content: string }) {
        return (
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={[rehypeSanitize]}
            components={baseMarkdownComponents}
          >
            {content}
          </ReactMarkdown>
        );
      },
    }),
  ),
);

function CopyButton({ text }: { text: string }) {
  const [copied, copy] = useCopyToClipboard();

  return (
    <button
      data-testid="code-block-copy"
      onClick={() => copy(text)}
      className="text-muted-foreground hover:bg-background/50 hover:text-foreground absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover/codeblock:opacity-100"
      aria-label="Copy code"
    >
      {copied ? <Check className="icon-base" /> : <Copy className="icon-base" />}
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
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    ensureLanguage(language).then(() => {
      if (!cancelled) {
        setHtml(highlightCode(code, language));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (html) {
    return (
      <code
        className="hljs block overflow-x-auto font-mono text-sm leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <code className={cn('block bg-muted p-2 rounded text-sm font-mono overflow-x-auto')}>
      {code}
    </code>
  );
}

/**
 * Inline markdown image. Web/data URLs render directly; a local file path the
 * agent emitted (e.g. `![shot](/abs/out.png)`) is routed through the runner's
 * `/api/files/raw` endpoint so the browser can load it. Clicking a local image
 * opens it in the shared media lightbox. `rehypeSanitize` keeps a protocol-less
 * absolute path (it has no scheme) but strips `data:` — consistent with the
 * app's markdown security policy.
 */
function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  // Proxied `/api/files/raw` URL immediately, upgraded to a signed direct-runner
  // URL (transport C) when the runner supports it. Falls back silently otherwise.
  const resolved = useResolvedMediaSrc(src);
  if (!resolved) return null;
  const isLocal = !!src && !isExternalUrl(src);
  // A local file claimed by a binary visualizer (e.g. the built-in video
  // renderer) is rendered through that visualizer inline — like GitHub turning
  // `![](clip.mp4)` into a player — rather than a broken <img> of raw bytes.
  // Images are the exception: a native <img> already renders them, and this sink
  // wraps locals in the click-to-zoom media lightbox below — richer than the bare
  // binary visualizer — so we keep images on that path even though an image
  // binary visualizer is registered (it covers the Monaco/internal-editor paths).
  if (isLocal && !IMAGE_EXTS.has(getFileExtension(src).toLowerCase())) {
    const viz = getVisualizerForFileExt(getFileExtension(src));
    if (viz?.contributes.binary) {
      const Visualizer = viz.Component;
      return (
        <div className="my-2" data-testid="markdown-binary-visualizer">
          <Visualizer source="" src={resolved} />
        </div>
      );
    }
  }
  const img = (
    <img
      src={resolved}
      alt={alt ?? ''}
      title={title}
      loading="lazy"
      data-testid="markdown-image"
      className="my-2 max-h-[60vh] max-w-full rounded border object-contain"
    />
  );
  if (!isLocal) return img;
  return (
    <button
      type="button"
      onClick={() => useMediaPreviewStore.getState().open(src as string)}
      className="block cursor-zoom-in"
      aria-label={alt ? `Open image: ${alt}` : 'Open image'}
      data-testid="markdown-image-button"
    >
      {img}
    </button>
  );
}

export const baseMarkdownComponents = {
  img: ({ src, alt, title }: any) => <MarkdownImage src={src} alt={alt} title={title} />,
  table: ({ children }: any) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
  // GFM task lists: render the native <input type="checkbox"> as a shadcn Checkbox.
  input: ({ type, checked, disabled, ...props }: any) => {
    if (type === 'checkbox') {
      return (
        <Checkbox
          checked={!!checked}
          disabled={disabled ?? true}
          // Task-list checkboxes are always read-only; keep full contrast (no
          // disabled dimming) so they render consistently across every theme.
          className="relative top-[2px] mr-1 inline-flex align-baseline disabled:cursor-default disabled:opacity-100"
          {...props}
        />
      );
    }
    return <input type={type} checked={checked} disabled={disabled} {...props} />;
  },
  // Drop the list marker on task-list items so the Checkbox stands alone.
  li: ({ className, children, ...props }: any) => {
    const isTask = typeof className === 'string' && className.includes('task-list-item');
    return (
      <li className={cn(className, isTask && 'list-none')} {...props}>
        {children}
      </li>
    );
  },
  code: ({ className, children, ...props }: any) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      const language = className.replace('language-', '');
      // Markdown and visualizer blocks are rendered by the pre handler — just
      // pass children through so the pre handler gets the raw source.
      if (MARKDOWN_LANGS.has(language) || getVisualizerForFence(language)) return <>{children}</>;
      const code = extractText(children).replace(/\n$/, '');
      return <HighlightedCode code={code} language={language} />;
    }
    // Code block without language — don't apply inline code background
    const text = extractText(children);
    if (text.includes('\n')) {
      return (
        <code className="block overflow-x-auto font-mono text-sm leading-relaxed" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="bg-muted-foreground/20 text-foreground rounded [box-decoration-break:clone] px-1 py-0.5 font-mono text-xs [-webkit-box-decoration-break:clone]"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }: any) => {
    const text = extractText(children).replace(/\n$/, '');
    const langClass = children?.props?.className;
    const language = langClass?.startsWith('language-') ? langClass.replace('language-', '') : null;

    // Visualizer blocks (mermaid, installed extensions): render inside a card
    // with a language header. Dispatched through the visualizer registry.
    const visualizer = language ? getVisualizerForFence(language) : undefined;
    if (visualizer) {
      const Visualizer = visualizer.Component;
      return (
        <div className="my-2">
          <div className="bg-muted overflow-x-auto rounded p-2">
            <div className="text-muted-foreground/80 mb-1 text-[10px] tracking-wider uppercase select-none">
              {language}
            </div>
            <Visualizer source={text} />
          </div>
        </div>
      );
    }

    const isMarkdown =
      (language && MARKDOWN_LANGS.has(language)) || (!language && looksLikeMarkdown(text));

    if (isMarkdown) {
      return (
        <div
          className={cn(
            markdownProseClassName,
            'border-border bg-muted/30 my-2 rounded border p-4',
          )}
        >
          <Suspense fallback={<div className="text-sm whitespace-pre-wrap">{text}</div>}>
            <LazyNestedMarkdown content={text} />
          </Suspense>
        </div>
      );
    }

    return (
      <div className="group/codeblock relative my-2">
        <pre className="bg-muted overflow-x-auto rounded p-2 font-mono text-sm leading-relaxed">
          {language && (
            <div className="text-muted-foreground/80 mb-1 text-[10px] tracking-wider uppercase select-none">
              {language}
            </div>
          )}
          {children}
        </pre>
        <CopyButton text={text} />
      </div>
    );
  },
};
