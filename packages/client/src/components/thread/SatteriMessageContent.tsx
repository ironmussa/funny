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
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { readProjects } from '@/data/projects/read';
import { ensureHighlight, highlightCode } from '@/hooks/use-highlight';
import { toEditorUriWithLine, openFileInEditor } from '@/lib/editor-utils';
import { MarkdownImage, markdownProseClassName } from '@/lib/markdown-components';
import { getMarkdownFileLinkPath, resolveMarkdownFilePath } from '@/lib/markdown-file-links';
import { renderMarkdownToSafeHtml, renderReadyMarkdownToSafeHtml } from '@/lib/satteri-markdown';
import {
  splitSatteriMarkdownSegments,
  type SatteriMarkdownSegment,
} from '@/lib/satteri-markdown-segments';
import { metric } from '@/lib/telemetry';
import { cn } from '@/lib/utils';
import { getVisualizerForFence } from '@/lib/visualizer-registry';
import { useAppStore } from '@/stores/app-store';
import { editorLabels, useSettingsStore } from '@/stores/settings-store';
import { readActiveThreadView } from '@/stores/thread-view';

type RenderedSegment =
  | { type: 'html'; html: string }
  | Exclude<SatteriMarkdownSegment, { type: 'html' }>;

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; segments: RenderedSegment[] }
  | { status: 'failed' };

function getInitialRenderState(segments: SatteriMarkdownSegment[]): RenderState {
  const rendered: RenderedSegment[] = [];
  try {
    for (const segment of segments) {
      if (segment.type !== 'html') {
        rendered.push(segment);
        continue;
      }
      const html = renderReadyMarkdownToSafeHtml(segment.markdown);
      if (html === undefined) return { status: 'loading' };
      rendered.push({ type: 'html', html });
    }
    return { status: 'ready', segments: rendered };
  } catch {
    // The async path reports compilation failures and preserves the source.
    return { status: 'loading' };
  }
}

function getActiveFileBasePath(): string | null {
  const appState = useAppStore.getState();
  const { selectedProjectId } = appState;
  const projects = readProjects();
  const activeThread = readActiveThreadView(appState);
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
  svg.classList.add('icon-base', 'copy-feedback-icon');
  if (icon === 'check') svg.classList.add('text-green-600');

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
    void ensureHighlight(source, language.slice('language-'.length)).then((available) => {
      if (available && code.isConnected && code.textContent === source) {
        // Both highlighters escape source before producing token markup.
        code.innerHTML = highlightCode(source, language.slice('language-'.length));
      }
    });
  }
}

class SatteriErrorBoundary extends Component<
  { content: string; children: ReactNode },
  { failed: boolean; content: string }
> {
  state = { failed: false, content: this.props.content };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  // Reset for each new message version, so a malformed streaming delta cannot
  // pin the completed message to the error state. This replaces a
  // content-keyed remount, which tore down and rebuilt the whole subtree
  // (DOM, islands, code highlighting) on every streamed chunk.
  static getDerivedStateFromProps(
    props: { content: string },
    state: { failed: boolean; content: string },
  ) {
    return props.content === state.content ? null : { failed: false, content: props.content };
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
  const { t } = useTranslation();
  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(t('common.copied', 'Copied'));
        return true;
      } catch {
        toast.error(t('common.copyFailed', 'Could not copy to clipboard'));
        return false;
      }
    },
    [t],
  );
  const copyTimers = useRef(new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = copyTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);
  const segments = useMemo(
    () =>
      splitSatteriMarkdownSegments(content, (language) => Boolean(getVisualizerForFence(language))),
    [content],
  );
  // Rendered synchronously when the compiler is ready (the common case);
  // otherwise the async result is kept with the segments it belongs to, so a
  // newer message version never shows an older compile.
  const initialState = useMemo(() => getInitialRenderState(segments), [segments]);
  const [asyncResult, setAsyncResult] = useState<{
    segments: SatteriMarkdownSegment[];
    state: RenderState;
  } | null>(null);
  const state: RenderState =
    initialState.status !== 'loading'
      ? initialState
      : asyncResult?.segments === segments
        ? asyncResult.state
        : initialState;

  useEffect(() => {
    if (initialState.status !== 'loading') return;
    let cancelled = false;
    void Promise.all(
      segments.map(async (segment): Promise<RenderedSegment> => {
        if (segment.type !== 'html') return segment;
        return { type: 'html', html: await renderMarkdownToSafeHtml(segment.markdown) };
      }),
    )
      .then((renderedSegments) => {
        if (!cancelled)
          setAsyncResult({ segments, state: { status: 'ready', segments: renderedSegments } });
      })
      .catch(() => {
        if (!cancelled) {
          metric('markdown.satteri_error', 1, { attributes: { reason: 'compile' } });
          setAsyncResult({ segments, state: { status: 'failed' } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [segments, initialState.status]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || state.status !== 'ready') return;
    enhanceStaticHtml(root);
    return scheduleIdle(() => highlightCodeBlocks(root));
  }, [state]);

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as Element | null;
      const copy = target?.closest<HTMLButtonElement>('[data-satteri-copy]');
      if (copy) {
        const code = copy.parentElement?.querySelector('pre > code')?.textContent ?? '';
        void copyText(code).then((success) => {
          if (!success || !rootRef.current?.contains(copy)) return;
          clearTimeout(copyTimers.current.get(copy));
          copy.setAttribute('aria-label', 'Copied');
          setCopyButtonIcon(copy, 'check');
          copyTimers.current.set(
            copy,
            setTimeout(() => {
              copy.setAttribute('aria-label', 'Copy code');
              setCopyButtonIcon(copy, 'copy');
              copyTimers.current.delete(copy);
            }, 2000),
          );
        });
        return;
      }

      const link = target?.closest<HTMLAnchorElement>('a[data-satteri-file-path]');
      const resolvedPath = link?.dataset.satteriFilePath;
      if (!link || !resolvedPath || toEditorUriWithLine(resolvedPath)) return;
      event.preventDefault();
      openFileInEditor(resolvedPath);
    },
    [copyText],
  );

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
    // Clicks are delegated to sanitized nested links and copy buttons; this container is not a control.
    // react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions
    <div
      ref={rootRef}
      className={cn(markdownProseClassName, 'overflow-hidden')}
      onClick={onClick}
      data-testid="satteri-markdown"
    >
      {state.segments.map((segment, index) =>
        segment.type === 'html' ? (
          // Segment order is fixed by the source; React only rewrites innerHTML when
          // a segment's HTML changed, so finished segments keep their DOM.
          // react-doctor-disable-next-line no-array-index-as-key
          <div
            key={`html-${index}`}
            // eslint-disable-next-line react-dom/no-dangerously-set-innerhtml -- renderMarkdownToSafeHtml sanitizes every compiler result
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        ) : (
          // Islands cannot reorder within a compiled result; they stay mounted while text streams.
          // react-doctor-disable-next-line no-array-index-as-key
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
  return (
    <SatteriErrorBoundary content={content}>
      <SatteriMessageContentInner content={content} />
    </SatteriErrorBoundary>
  );
});
