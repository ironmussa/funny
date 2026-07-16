import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { ensureLanguage, highlightCode } from '@/hooks/use-highlight';
import { toEditorUriWithLine, openFileInEditor } from '@/lib/editor-utils';
import { MarkdownImage, markdownProseClassName } from '@/lib/markdown-components';
import { getMarkdownFileLinkPath, resolveMarkdownFilePath } from '@/lib/markdown-file-links';
import { renderMarkdownToSafeHtml } from '@/lib/satteri-markdown';
import {
  splitSatteriMarkdownSegments,
  type SatteriMarkdownSegment,
} from '@/lib/satteri-markdown-segments';
import { metric } from '@/lib/telemetry';
import { cn } from '@/lib/utils';
import { getVisualizerForFence } from '@/lib/visualizer-registry';
import { useAppStore } from '@/stores/app-store';
import { editorLabels, useSettingsStore } from '@/stores/settings-store';

type RenderedSegment =
  | { type: 'html'; html: string }
  | Exclude<SatteriMarkdownSegment, { type: 'html' }>;

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; segments: RenderedSegment[] }
  | { status: 'failed' };

function getActiveFileBasePath(): string | null {
  const { activeThread, projects, selectedProjectId } = useAppStore.getState();
  const projectId = activeThread?.projectId ?? selectedProjectId;
  const projectPath = projectId ? projects.find((project) => project.id === projectId)?.path : null;
  return activeThread?.worktreePath || projectPath || null;
}

function scheduleIdle(work: () => void): () => void {
  const idleWindow = window as Window & {
    cancelIdleCallback?: (id: number) => void;
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };
  if (idleWindow.requestIdleCallback) {
    const id = idleWindow.requestIdleCallback(work, { timeout: 200 });
    return () => idleWindow.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(work, 0);
  return () => window.clearTimeout(id);
}

function SatteriRenderError({
  content,
  reason,
}: {
  content: string;
  reason: 'compile' | 'render';
}) {
  return (
    <div
      className="border-destructive/40 bg-destructive/5 text-foreground rounded border p-3 text-sm"
      data-satteri-error={reason}
      role="alert"
    >
      <p className="text-muted-foreground mb-2">
        Markdown could not be rendered. Showing the original message text.
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap">{content}</pre>
    </div>
  );
}

function setCopyButtonIcon(button: HTMLButtonElement, icon: 'copy' | 'check'): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('data-satteri-copy-icon', icon);
  svg.classList.add('icon-base');

  const paths: Array<[tag: string, attributes: string[]]> =
    icon === 'copy'
      ? [
          ['rect', ['width', '14', 'height', '14', 'x', '8', 'y', '8', 'rx', '2', 'ry', '2']],
          ['path', ['d', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2']],
        ]
      : [['path', ['d', 'M20 6 9 17l-5-5']]];

  for (const [tag, attributes] of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (let index = 0; index < attributes.length; index += 2) {
      path.setAttribute(attributes[index], attributes[index + 1]);
    }
    svg.append(path);
  }

  button.replaceChildren(svg);
}

function enhanceStaticHtml(root: HTMLElement): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href');
    const filePath = getMarkdownFileLinkPath(href, link.textContent);
    if (filePath) {
      const { defaultEditor, useInternalEditor } = useSettingsStore.getState();
      const resolvedPath = resolveMarkdownFilePath(filePath, getActiveFileBasePath());
      const uri = toEditorUriWithLine(resolvedPath, defaultEditor);
      link.dataset.satteriFilePath = resolvedPath;
      link.classList.add('hover:underline');
      link.title = `Open in ${useInternalEditor ? 'internal editor' : editorLabels[defaultEditor]}: ${resolvedPath}`;
      if (uri) link.href = uri;
      continue;
    }
    if (/^https?:\/\//i.test(href ?? '')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.classList.add('hover:underline');
    }
  }

  for (const table of root.querySelectorAll<HTMLTableElement>('table')) {
    if (table.parentElement?.classList.contains('overflow-x-auto')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'overflow-x-auto';
    table.replaceWith(wrapper);
    wrapper.append(table);
  }

  for (const pre of root.querySelectorAll<HTMLElement>('pre')) {
    if (pre.dataset.satteriEnhanced === 'true') continue;
    const code = pre.querySelector<HTMLElement>('code');
    if (!code) continue;
    pre.dataset.satteriEnhanced = 'true';
    pre.classList.add(
      'bg-muted',
      'overflow-x-auto',
      'rounded',
      'p-2',
      'font-mono',
      'text-sm',
      'leading-relaxed',
    );
    // Apply the highlighted block's box model before the first paint. Language
    // loading only replaces this element's text with token spans, so it must
    // not be allowed to alter the block height after it is visible.
    code.classList.add(
      'hljs',
      'block',
      'overflow-x-auto',
      'font-mono',
      'text-sm',
      'leading-relaxed',
    );

    const group = document.createElement('div');
    group.className = 'group/codeblock relative my-2';
    pre.replaceWith(group);
    group.append(pre);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.dataset.satteriCopy = 'true';
    copy.dataset.testid = 'satteri-code-copy';
    copy.setAttribute('aria-label', 'Copy code');
    copy.className =
      'text-muted-foreground hover:bg-background/50 hover:text-foreground absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover/codeblock:opacity-100';
    setCopyButtonIcon(copy, 'copy');
    group.append(copy);
  }
}

function highlightCodeBlocks(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    if (code.dataset.satteriHighlighted === 'true') continue;
    const language = Array.from(code.classList).find((className) =>
      className.startsWith('language-'),
    );
    if (!language) continue;
    code.dataset.satteriHighlighted = 'true';
    const source = code.textContent ?? '';
    void ensureLanguage(language.slice('language-'.length)).then((available) => {
      if (available && code.isConnected) {
        // highlight.js returns escaped token markup for source read from textContent.
        code.innerHTML = highlightCode(source, language.slice('language-'.length));
      }
    });
  }
}

class SatteriErrorBoundary extends Component<
  { content: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    metric('markdown.satteri_error', 1, { attributes: { reason: 'render' } });
  }

  render() {
    return this.state.failed ? (
      <SatteriRenderError content={this.props.content} reason="render" />
    ) : (
      this.props.children
    );
  }
}

function MarkdownIsland({ segment }: { segment: Exclude<RenderedSegment, { type: 'html' }> }) {
  if (segment.type === 'image') {
    return <MarkdownImage src={segment.src} alt={segment.alt} title={segment.title} />;
  }
  if (segment.type === 'nested-markdown') {
    return (
      <div
        className={cn(markdownProseClassName, 'border-border bg-muted/30 my-2 rounded border p-4')}
      >
        <SatteriMessageContent content={segment.markdown} />
      </div>
    );
  }

  const visualizer = getVisualizerForFence(segment.language);
  if (!visualizer)
    return (
      <SatteriMessageContent content={`\`\`\`${segment.language}\n${segment.source}\n\`\`\``} />
    );
  const Visualizer = visualizer.Component;
  return (
    <div className="my-2">
      <div className="bg-muted overflow-x-auto rounded p-2">
        <div className="text-muted-foreground/80 mb-1 text-[10px] tracking-wider uppercase select-none">
          {segment.language}
        </div>
        <Visualizer source={segment.source} />
      </div>
    </div>
  );
}

function SatteriMessageContentInner({ content }: { content: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const segments = useMemo(
    () =>
      splitSatteriMarkdownSegments(content, (language) => Boolean(getVisualizerForFence(language))),
    [content],
  );
  const [state, setState] = useState<RenderState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void Promise.all(
      segments.map(async (segment): Promise<RenderedSegment> => {
        if (segment.type !== 'html') return segment;
        return { type: 'html', html: await renderMarkdownToSafeHtml(segment.markdown) };
      }),
    )
      .then((renderedSegments) => {
        if (!cancelled) setState({ status: 'ready', segments: renderedSegments });
      })
      .catch(() => {
        if (!cancelled) {
          metric('markdown.satteri_error', 1, { attributes: { reason: 'compile' } });
          setState({ status: 'failed' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [content, segments]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || state.status !== 'ready') return;
    enhanceStaticHtml(root);
    return scheduleIdle(() => highlightCodeBlocks(root));
  }, [state]);

  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    const copy = target?.closest<HTMLButtonElement>('[data-satteri-copy]');
    if (copy) {
      const code = copy.parentElement?.querySelector('pre > code')?.textContent ?? '';
      void navigator.clipboard?.writeText(code);
      copy.setAttribute('aria-label', 'Copied');
      setCopyButtonIcon(copy, 'check');
      return;
    }

    const link = target?.closest<HTMLAnchorElement>('a[data-satteri-file-path]');
    const resolvedPath = link?.dataset.satteriFilePath;
    if (!link || !resolvedPath || toEditorUriWithLine(resolvedPath)) return;
    event.preventDefault();
    openFileInEditor(resolvedPath);
  }, []);

  if (state.status === 'loading') {
    return (
      <div
        className={cn(markdownProseClassName, 'text-foreground whitespace-pre-wrap')}
        data-satteri-pending="true"
      >
        {content}
      </div>
    );
  }
  if (state.status === 'failed') {
    return <SatteriRenderError content={content} reason="compile" />;
  }

  return (
    <div
      ref={rootRef}
      className={cn(markdownProseClassName, 'overflow-hidden')}
      onClick={onClick}
      data-testid="satteri-markdown"
    >
      {state.segments.map((segment, index) =>
        segment.type === 'html' ? (
          <div
            key={`html-${index}`}
            // eslint-disable-next-line react-dom/no-dangerously-set-innerhtml -- renderMarkdownToSafeHtml sanitizes every compiler result
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        ) : (
          <MarkdownIsland key={`island-${index}`} segment={segment} />
        ),
      )}
    </div>
  );
}

export const SatteriMessageContent = memo(function SatteriMessageContent({
  content,
}: {
  content: string;
}) {
  // Reset the error boundary for a changed message so a malformed streaming
  // delta cannot pin the completed message to a plain-text error state.
  return (
    <SatteriErrorBoundary key={content} content={content}>
      <SatteriMessageContentInner content={content} />
    </SatteriErrorBoundary>
  );
});
