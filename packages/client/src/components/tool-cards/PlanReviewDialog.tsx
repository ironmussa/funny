import { BookOpen, Code, MessageSquare, Pencil } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Suspense, lazy, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { createClientLogger } from '@/lib/client-logger';
import { remarkPlugins } from '@/lib/markdown-components';
import { parsePlanSections, type PlanSection } from '@/lib/parse-plan-sections';
import { cn } from '@/lib/utils';
import { useSettingsStore, EDITOR_FONT_SIZE_PX } from '@/stores/settings-store';

import { AnnotatableContent } from './AnnotatableContent';

const LazyEditor = lazy(() =>
  import('@monaco-editor/react').then((mod) => ({ default: mod.Editor })),
);

const LazyReactMarkdown = lazy(() => import('react-markdown'));

const _log = createClientLogger('PlanReviewDialog');

const PROSE_CLASSES =
  'prose prose-xs prose-invert prose-headings:text-foreground prose-headings:font-semibold prose-h1:text-xs prose-h1:mb-1.5 prose-h1:mt-0 prose-h2:text-xs prose-h2:mb-1 prose-h2:mt-2.5 prose-h3:text-sm prose-h3:mb-1 prose-h3:mt-2 prose-p:text-xs prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:my-0.5 prose-li:text-sm prose-li:text-muted-foreground prose-li:leading-relaxed prose-li:my-0 prose-ul:my-0.5 prose-ol:my-0.5 prose-code:text-xs prose-code:bg-background/80 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground prose-pre:bg-background/80 prose-pre:rounded prose-pre:p-2 prose-pre:my-1 prose-strong:text-foreground max-w-none';

export const EMOJI_OPTIONS = [
  '\u{1F44D}',
  '\u{1F44E}',
  '\u{2764}\u{FE0F}',
  '\u{1F440}',
  '\u{26A0}\u{FE0F}',
  '\u{2705}',
];

/* ── Markdown renderer with scroll-spy anchors on headings ──────────── */

function PlanMarkdownWithAnchors({ plan, sections }: { plan: string; sections: PlanSection[] }) {
  const titleToId = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sections) {
      if (s.title) map.set(s.title, s.id);
    }
    return map;
  }, [sections]);

  const components = useMemo(
    () => ({
      h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => {
        const text = String(children ?? '');
        const sectionId = titleToId.get(text);
        return (
          <h1
            {...props}
            {...(sectionId != null && {
              id: `plan-review-section-${sectionId}`,
              'data-section-id': sectionId,
            })}
          >
            {children}
          </h1>
        );
      },
      h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => {
        const text = String(children ?? '');
        const sectionId = titleToId.get(text);
        return (
          <h2
            {...props}
            {...(sectionId != null && {
              id: `plan-review-section-${sectionId}`,
              'data-section-id': sectionId,
            })}
          >
            {children}
          </h2>
        );
      },
      h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => {
        const text = String(children ?? '');
        const sectionId = titleToId.get(text);
        return (
          <h3
            {...props}
            {...(sectionId != null && {
              id: `plan-review-section-${sectionId}`,
              'data-section-id': sectionId,
            })}
          >
            {children}
          </h3>
        );
      },
    }),
    [titleToId],
  );

  return (
    <Suspense
      fallback={
        <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
          {plan}
        </pre>
      }
    >
      <LazyReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {plan}
      </LazyReactMarkdown>
    </Suspense>
  );
}

export interface PlanComment {
  selectedText: string;
  comment: string;
  emoji?: string;
}

/* ── Selection popover (appears when user selects text) ────────────────── */

export function SelectionPopover({
  position,
  selectedText,
  onComment,
  onEmoji,
  onClose,
}: {
  position: { x: number; y: number };
  selectedText: string;
  onComment: (text: string, comment: string) => void;
  onEmoji: (text: string, emoji: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [showInput, setShowInput] = useState(false);
  const [comment, setComment] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showInput) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [showInput]);

  const handleSubmitComment = () => {
    const text = comment.trim();
    if (!text) return;
    onComment(selectedText, text);
    setComment('');
    setShowInput(false);
    onClose();
  };

  return (
    <div
      ref={popoverRef}
      className="absolute z-[100]"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%) translateY(-8px)',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="plan-selection-popover"
    >
      <div className="rounded-lg border border-border bg-card shadow-xl">
        {!showInput ? (
          <div className="flex items-center gap-0.5 px-1 py-1">
            {EMOJI_OPTIONS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => {
                  onEmoji(selectedText, emoji);
                  onClose();
                }}
                data-testid={`plan-emoji-${emoji}`}
                className="rounded px-1.5 py-1 text-sm transition-colors hover:bg-accent"
              >
                {emoji}
              </button>
            ))}
            <div className="mx-0.5 h-5 w-px bg-border" />
            <button
              onClick={() => setShowInput(true)}
              data-testid="plan-comment-button"
              className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              {t('plan.comment', 'Comment')}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmitComment();
                }
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setShowInput(false);
                  setComment('');
                }
              }}
              placeholder={t('plan.addComment', 'Add comment...')}
              data-testid="plan-selection-comment-input"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
            />
            <Button
              size="sm"
              onClick={handleSubmitComment}
              disabled={!comment.trim()}
              data-testid="plan-selection-comment-submit"
              className="h-7 shrink-0 px-3 text-sm"
            >
              {t('plan.comment', 'Comment')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Outline sidebar ──────────────────────────────────────────────────── */

function PlanOutline({
  sections,
  activeSectionId,
  onNavigate,
}: {
  sections: PlanSection[];
  activeSectionId: number | null;
  onNavigate: (id: number) => void;
}) {
  const titled = sections.filter((s) => s.title);
  if (titled.length < 2) return null;

  return (
    <nav
      className="w-56 flex-shrink-0 overflow-y-auto border-r border-border/40 py-3"
      data-testid="plan-review-outline"
    >
      <ul className="space-y-0.5 px-2">
        {titled.map((section) => (
          <li key={section.id}>
            <button
              onClick={() => onNavigate(section.id)}
              data-testid={`plan-outline-item-${section.id}`}
              className={cn(
                'w-full truncate rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent',
                section.level >= 3 && 'pl-5',
                section.level >= 4 && 'pl-8',
                activeSectionId === section.id
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {section.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ── DOM highlighting: find text in container and wrap with <mark> ────── */

/** Collect all text nodes under a container */
export function collectTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  return nodes;
}

/**
 * Highlight matching text by wrapping individual text nodes with <mark>.
 * Handles selections that span multiple elements.
 * Uses the same highlight style as HighlightText (yellow bg, black text).
 * Returns the first <mark> element created (for positioning margin icons).
 */
export function highlightTextInDom(
  container: HTMLElement,
  text: string,
  annotationIndex: number,
): HTMLElement | null {
  const searchText = text.replace(/\s+/g, ' ').trim();
  if (!searchText) return null;

  const textNodes = collectTextNodes(container);

  // Build concatenated text with a map of charIndex → { textNode, offset }
  let concat = '';
  const charMap: { node: Text; offset: number }[] = [];
  for (const tn of textNodes) {
    const val = tn.nodeValue ?? '';
    for (let i = 0; i < val.length; i++) {
      charMap.push({ node: tn, offset: i });
    }
    concat += val;
  }

  // Normalize whitespace for matching
  const normConcat = concat.replace(/\s+/g, ' ');
  const normIdx = normConcat.indexOf(searchText);
  if (normIdx === -1) return null;

  // Map normalized index back to original index
  let origStart = -1;
  let ni = 0;
  for (let oi = 0; oi < concat.length; oi++) {
    if (ni === normIdx && origStart === -1) origStart = oi;
    const ch = concat[oi];
    if (/\s/.test(ch)) {
      if (ni === 0 || normConcat[ni - 1] !== ' ') ni++;
    } else {
      ni++;
    }
  }
  if (origStart === -1) return null;

  // Find the end in original text
  let matched = 0;
  let origEnd = origStart;
  for (let oi = origStart; oi < charMap.length && matched < searchText.length; oi++) {
    const ch = concat[oi];
    const expected = searchText[matched];
    if (ch === expected) {
      matched++;
      origEnd = oi;
    } else if (/\s/.test(ch) && expected === ' ') {
      matched++;
      origEnd = oi;
    } else if (/\s/.test(ch)) {
      origEnd = oi; // skip extra whitespace
    }
  }

  // Group chars by text node to wrap each node segment separately
  const segments = new Map<Text, { start: number; end: number }>();
  for (let i = origStart; i <= origEnd; i++) {
    const entry = charMap[i];
    if (!entry) continue;
    const existing = segments.get(entry.node);
    if (existing) {
      existing.end = Math.max(existing.end, entry.offset);
    } else {
      segments.set(entry.node, { start: entry.offset, end: entry.offset });
    }
  }

  let firstMark: HTMLElement | null = null;

  // Wrap each segment in its own <mark> — works across element boundaries
  for (const [textNode, { start, end }] of segments) {
    const nodeText = textNode.nodeValue ?? '';
    const before = nodeText.slice(0, start);
    const highlighted = nodeText.slice(start, end + 1);
    const after = nodeText.slice(end + 1);

    // Skip whitespace-only segments (line breaks between elements)
    if (!highlighted.trim()) continue;

    const mark = document.createElement('mark');
    mark.setAttribute('data-annotation-index', String(annotationIndex));
    mark.style.backgroundColor = '#FFE500';
    mark.style.color = 'black';
    mark.style.padding = '0';
    mark.style.margin = '0';
    mark.textContent = highlighted;

    const parent = textNode.parentNode;
    if (!parent) continue;

    if (before) parent.insertBefore(document.createTextNode(before), textNode);
    parent.insertBefore(mark, textNode);
    if (after) parent.insertBefore(document.createTextNode(after), textNode);
    parent.removeChild(textNode);

    if (!firstMark) firstMark = mark;
  }

  return firstMark;
}

/* ── Margin annotation indicator ─────────────────────────────────────── */

export interface AnnotationPosition {
  index: number;
  top: number;
  emoji?: string;
  comment: string;
}

/** Group annotations that are within `threshold` px vertically */
function groupAnnotationsByRow(annotations: AnnotationPosition[], threshold = 12) {
  if (annotations.length === 0) return [];
  const sorted = [...annotations].sort((a, b) => a.top - b.top);
  const groups: { top: number; items: AnnotationPosition[] }[] = [];
  let current = { top: sorted[0].top, items: [sorted[0]] };

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].top - current.top) <= threshold) {
      current.items.push(sorted[i]);
    } else {
      groups.push(current);
      current = { top: sorted[i].top, items: [sorted[i]] };
    }
  }
  groups.push(current);
  return groups;
}

export function MarginAnnotations({
  annotations,
  onRemove,
}: {
  annotations: AnnotationPosition[];
  onRemove: (index: number) => void;
}) {
  const groups = useMemo(() => groupAnnotationsByRow(annotations), [annotations]);
  if (groups.length === 0) return null;

  return (
    <div className="absolute right-1 top-0 w-10" data-testid="plan-margin-annotations">
      {groups.map((group) => (
        <div
          key={group.top}
          className="absolute right-0 flex items-center gap-px rounded-full border border-border/60 bg-card px-px py-px"
          style={{ top: group.top }}
        >
          {group.items.map((a) => (
            <Tooltip key={a.index}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onRemove(a.index)}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-[10px] transition-colors hover:bg-destructive/20"
                  data-testid={`plan-margin-annotation-${a.index}`}
                >
                  {a.emoji || <MessageSquare className="h-3 w-3 text-primary" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-56 text-xs">
                {a.comment && <p>{a.comment}</p>}
                {!a.comment && a.emoji && <p>Reaction</p>}
                <p className="text-muted-foreground/50">Click to remove</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Main dialog ──────────────────────────────────────────────────────── */

export function PlanReviewDialog({
  open,
  onOpenChange,
  plan,
  planComments,
  onAddComment,
  onAddEmoji,
  onRemoveComment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: string;
  planComments: PlanComment[];
  onAddComment: (selectedText: string, comment: string) => void;
  onAddEmoji: (selectedText: string, emoji: string) => void;
  onRemoveComment: (index: number) => void;
}) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const codeFontSizePx = EDITOR_FONT_SIZE_PX[useSettingsStore((s) => s.fontSize)];

  // ── Edit mode ──
  const [isEditing, setIsEditing] = useState(false);
  const [editablePlan, setEditablePlan] = useState(plan);

  // Sync editablePlan when plan prop changes
  useEffect(() => {
    setEditablePlan(plan);
  }, [plan]);

  // Use edited content for rendering
  const activePlan = isEditing ? editablePlan : editablePlan;
  const sections = useMemo(() => parsePlanSections(activePlan), [activePlan]);
  const hasSections = sections.length > 1 || (sections.length === 1 && sections[0].level > 0);

  const monacoTheme = resolvedTheme === 'monochrome' ? 'vs' : 'funny-dark';

  const handleBeforeMount = (monaco: any) => {
    monaco.editor.defineTheme('funny-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#000000',
        'editorGutter.background': '#000000',
        'minimap.background': '#0a0a0a',
        'editorWidget.background': '#1e1e1e',
        'editorWidget.border': '#454545',
        'editorWidget.foreground': '#cccccc',
        'input.background': '#2a2a2a',
        'input.foreground': '#cccccc',
        'input.border': '#454545',
        focusBorder: '#007acc',
      },
    });
  };

  // ── Active section tracking via scroll ──
  const [activeSectionId, setActiveSectionId] = useState<number | null>(sections[0]?.id ?? null);

  const handleNavigate = useCallback((id: number) => {
    const el = document.getElementById(`plan-review-section-${id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveSectionId(id);
  }, []);

  // Scroll spy
  useEffect(() => {
    if (!open || !hasSections) return;
    const container = dialogRef.current?.querySelector(
      '[data-testid="annotatable-content"]',
    ) as HTMLElement | null;
    if (!container) return;
    const handleScroll = () => {
      const sectionEls = container.querySelectorAll('[data-section-id]');
      let closest: { id: number; dist: number } | null = null;
      sectionEls.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const dist = Math.abs(rect.top - containerRect.top);
        const id = Number(el.getAttribute('data-section-id'));
        if (!closest || dist < closest.dist) closest = { id, dist };
      });
      if (closest) setActiveSectionId((closest as { id: number; dist: number }).id);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [open, hasSections]);

  const dialogRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={dialogRef}
        className="max-w-none overflow-hidden rounded-lg"
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '60vw',
          height: '80vh',
          padding: 0,
          gap: 0,
        }}
        data-testid="plan-review-dialog"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-shrink-0 select-none overflow-hidden border-b border-border px-4 py-3">
          <DialogTitle className="flex min-w-0 items-center gap-2 overflow-hidden text-sm">
            <Pencil className="icon-base flex-shrink-0" />
            {t('plan.reviewTitle', 'Review plan')}
          </DialogTitle>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setIsEditing((prev) => !prev)}
                data-testid="plan-review-toggle-edit"
                className="flex-shrink-0 text-muted-foreground"
              >
                {isEditing ? <BookOpen className="icon-base" /> : <Code className="icon-base" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isEditing ? t('plan.showPreview', 'Preview') : t('plan.editPlan', 'Edit')}
            </TooltipContent>
          </Tooltip>
          <DialogDescription className="sr-only">
            {isEditing
              ? t('plan.editDescription', 'Edit the plan markdown directly')
              : t('plan.reviewDescription', 'Select text to leave comments')}
          </DialogDescription>
        </DialogHeader>

        {/* ── Body: editor or outline + content ── */}
        {isEditing ? (
          <div className="min-h-0 flex-1 overflow-hidden" data-testid="plan-review-editor">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading editor...
                </div>
              }
            >
              <LazyEditor
                height="100%"
                language="markdown"
                theme={monacoTheme}
                beforeMount={handleBeforeMount}
                value={editablePlan}
                onChange={(value: string | undefined) => setEditablePlan(value || '')}
                options={{
                  minimap: { enabled: false },
                  fontSize: codeFontSizePx,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  lineNumbers: 'on',
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                }}
              />
            </Suspense>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {hasSections && (
              <PlanOutline
                sections={sections}
                activeSectionId={activeSectionId}
                onNavigate={handleNavigate}
              />
            )}

            {/* Main content with right margin for annotation indicators */}
            <AnnotatableContent
              className="min-h-0 flex-1 overflow-y-auto px-4 py-3 pr-16 text-sm"
              planComments={planComments}
              onAddComment={onAddComment}
              onAddEmoji={onAddEmoji}
              onRemoveComment={onRemoveComment}
              active={open && !isEditing}
              highlightDeps={[open]}
              highlightDelay={50}
            >
              <div className={PROSE_CLASSES}>
                <PlanMarkdownWithAnchors plan={activePlan} sections={sections} />
              </div>
            </AnnotatableContent>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
