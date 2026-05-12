import { MessageSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const EMOJI_OPTIONS = [
  '\u{1F44D}',
  '\u{1F44E}',
  '\u{2764}\u{FE0F}',
  '\u{1F440}',
  '\u{26A0}\u{FE0F}',
  '\u{2705}',
];

export interface PlanComment {
  selectedText: string;
  comment: string;
  emoji?: string;
}

export interface AnnotationPosition {
  index: number;
  top: number;
  emoji?: string;
  comment: string;
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
              <MessageSquare className="size-3.5" />
              {t('plan.comment', 'Comment')}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <Input
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
              className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm text-foreground shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
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

/* ── DOM highlighting: find text in container and wrap with <mark> ────── */

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
    mark.style.cssText = 'background-color:#FFE500;color:black;padding:0;margin:0';
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

/** Group annotations that are within `threshold` px vertically */
function groupAnnotationsByRow(annotations: AnnotationPosition[], threshold = 12) {
  if (annotations.length === 0) return [];
  const sorted = annotations.toSorted((a, b) => a.top - b.top);
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
                  className="flex size-4 items-center justify-center rounded-full text-[10px] transition-colors hover:bg-destructive/20"
                  data-testid={`plan-margin-annotation-${a.index}`}
                >
                  {a.emoji || <MessageSquare className="size-3 text-primary" />}
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
