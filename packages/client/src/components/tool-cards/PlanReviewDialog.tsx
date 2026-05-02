import { BookOpen, Code, Pencil } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { createClientLogger } from '@/lib/client-logger';
import { remarkPlugins } from '@/lib/markdown-components';
import { parsePlanSections, type PlanSection } from '@/lib/parse-plan-sections';
import { cn } from '@/lib/utils';
import { useSettingsStore, EDITOR_FONT_SIZE_PX } from '@/stores/settings-store';

import { AnnotatableContent } from './AnnotatableContent';
import {
  type AnnotationPosition,
  type PlanComment,
  collectTextNodes,
  highlightTextInDom,
} from './plan-annotations';

// Re-export so existing importers (ExitPlanModeCard, stories) keep working.
export type { PlanComment, AnnotationPosition } from './plan-annotations';
export {
  SelectionPopover,
  MarginAnnotations,
  collectTextNodes,
  highlightTextInDom,
  EMOJI_OPTIONS,
} from './plan-annotations';

const LazyEditor = lazy(() =>
  import('@monaco-editor/react').then((mod) => ({ default: mod.Editor })),
);

const LazyReactMarkdown = lazy(() => import('react-markdown'));

const _log = createClientLogger('PlanReviewDialog');

const PROSE_CLASSES =
  'prose prose-xs prose-invert prose-headings:text-foreground prose-headings:font-semibold prose-h1:text-xs prose-h1:mb-1.5 prose-h1:mt-0 prose-h2:text-xs prose-h2:mb-1 prose-h2:mt-2.5 prose-h3:text-sm prose-h3:mb-1 prose-h3:mt-2 prose-p:text-xs prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:my-0.5 prose-li:text-sm prose-li:text-muted-foreground prose-li:leading-relaxed prose-li:my-0 prose-ul:my-0.5 prose-ol:my-0.5 prose-code:text-xs prose-code:bg-background/80 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground prose-pre:bg-background/80 prose-pre:rounded prose-pre:p-2 prose-pre:my-1 prose-strong:text-foreground max-w-none';

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
    <ScrollArea
      className="w-56 flex-shrink-0 border-r border-border/40 py-3"
      data-testid="plan-review-outline"
    >
      <nav>
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
    </ScrollArea>
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
