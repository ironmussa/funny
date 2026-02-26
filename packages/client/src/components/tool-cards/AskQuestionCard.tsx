import { MessageCircleQuestion, Check, Send, PenLine, ChevronRight } from 'lucide-react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { getQuestions, type Question } from './utils';

// Special index to represent "Other" option
const OTHER_INDEX = -1;

/**
 * Parse the output string back into selections and otherTexts maps
 * by matching answer lines against the original question options.
 * Output format:
 *   [Header] Question text
 *   → Option Label — Option Description
 *   → Other — free text
 */
function parseOutputToSelections(
  output: string,
  questions: Question[],
): { selections: Map<number, Set<number>>; otherTexts: Map<number, string> } {
  const selections = new Map<number, Set<number>>();
  const otherTexts = new Map<number, string>();

  // Split output into question blocks (separated by blank lines)
  const blocks = output.split('\n\n');

  blocks.forEach((block) => {
    const lines = block.split('\n');
    if (lines.length === 0) return;

    // First line is "[Header] Question text" — match to a question by header
    const headerMatch = lines[0].match(/^\[(.+?)\]/);
    if (!headerMatch) return;
    const header = headerMatch[1];
    const qIndex = questions.findIndex((q) => q.header === header);
    if (qIndex === -1) return;

    const q = questions[qIndex];
    const selected = new Set<number>();

    // Remaining lines are "→ Label — Description"
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].replace(/^→\s*/, '');
      if (!line) continue;

      // Try to match against known options by label
      const dashIdx = line.indexOf('—');
      const label = dashIdx !== -1 ? line.substring(0, dashIdx).trim() : line.trim();
      const optIndex = q.options.findIndex((opt) => opt.label === label);
      if (optIndex !== -1) {
        selected.add(optIndex);
      } else {
        // Unrecognized option — treat as "Other" answer (locale-independent)
        const otherText = dashIdx !== -1 ? line.substring(dashIdx + 1).trim() : line;
        selected.add(OTHER_INDEX);
        otherTexts.set(qIndex, otherText);
      }
    }

    if (selected.size > 0) {
      selections.set(qIndex, selected);
    }
  });

  return { selections, otherTexts };
}

export function AskQuestionCard({
  parsed,
  onRespond,
  output,
  hideLabel,
}: {
  parsed: Record<string, unknown>;
  onRespond?: (answer: string) => void;
  output?: string;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const questions = getQuestions(parsed);
  if (!questions || questions.length === 0) return null;

  const alreadyAnswered = !!output;
  // Parse existing output back into selections for read-only display
  const restoredState = useMemo(() => {
    if (!alreadyAnswered) return null;
    return parseOutputToSelections(output!, questions);
  }, [alreadyAnswered, output, questions]);

  const [activeTab, setActiveTab] = useState(0);
  const [selections, setSelections] = useState<Map<number, Set<number>>>(
    () => restoredState?.selections ?? new Map(),
  );
  const [submitted, setSubmitted] = useState(alreadyAnswered);
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(
    () => restoredState?.otherTexts ?? new Map(),
  );
  const otherInputRef = useRef<HTMLTextAreaElement>(null);

  const toggleOption = (qIndex: number, optIndex: number, multiSelect: boolean) => {
    if (submitted) return;
    setSelections((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(qIndex) || []);
      if (multiSelect) {
        if (current.has(optIndex)) current.delete(optIndex);
        else current.add(optIndex);
      } else {
        current.clear();
        current.add(optIndex);
      }
      next.set(qIndex, current);
      return next;
    });

    // Auto-advance to next question if:
    // - Not multi-select (single selection)
    // - Not selecting "Other" (which requires text input)
    // - Not on the last question
    if (!multiSelect && optIndex !== OTHER_INDEX && qIndex < questions.length - 1) {
      // Use setTimeout to ensure state update completes before advancing
      setTimeout(() => setActiveTab(qIndex + 1), 150);
    }
  };

  // Focus the textarea when "Other" is selected
  useEffect(() => {
    const activeSelections = selections.get(activeTab);
    if (activeSelections?.has(OTHER_INDEX) && otherInputRef.current) {
      otherInputRef.current.focus();
    }
  }, [selections, activeTab]);

  const handleSubmit = () => {
    if (submitted || !onRespond) return;
    const parts: string[] = [];
    questions.forEach((q, qi) => {
      const selected = selections.get(qi);
      if (selected && selected.size > 0) {
        const answers = Array.from(selected)
          .map((i) => {
            if (i === OTHER_INDEX) {
              const text = otherTexts.get(qi)?.trim();
              return text ? `${t('tools.other')} — ${text}` : '';
            }
            const opt = q.options[i];
            return opt ? `${opt.label} — ${opt.description}` : '';
          })
          .filter(Boolean);
        parts.push(`[${q.header}] ${q.question}\n→ ${answers.join('\n→ ')}`);
      }
    });
    if (parts.length > 0) {
      onRespond(parts.join('\n\n'));
      setSubmitted(true);
    }
  };

  const activeQ = questions[activeTab];
  const activeSelections = selections.get(activeTab) || new Set<number>();
  const isOtherSelected = activeSelections.has(OTHER_INDEX);
  const otherText = otherTexts.get(activeTab) || '';

  // Calculate max height needed across all tabs (including "Other" option and textarea)
  const maxContentHeight = useMemo(() => {
    return questions.reduce((max, q, qIndex) => {
      // Base height: options + "Other" button
      const optionsCount = q.options.length + 1; // +1 for "Other"
      let height = optionsCount * 40; // approximate height per option (py-1.5 + gap)

      // Add height for "Other" textarea if selected for this question
      const qSelections = selections.get(qIndex);
      if (qSelections?.has(OTHER_INDEX)) {
        height += 70; // textarea min-height + margins
      }

      return Math.max(max, height);
    }, 0);
  }, [questions, selections]);

  const allAnswered = questions.every((_, i) => {
    const sel = selections.get(i);
    if (!sel || sel.size === 0) return false;
    // If "Other" is the only selection, require text
    if (sel.has(OTHER_INDEX) && sel.size === 1) {
      return (otherTexts.get(i)?.trim().length ?? 0) > 0;
    }
    return true;
  });

  const currentTabAnswered = (() => {
    const sel = selections.get(activeTab);
    if (!sel || sel.size === 0) return false;
    if (sel.has(OTHER_INDEX) && sel.size === 1) {
      return (otherTexts.get(activeTab)?.trim().length ?? 0) > 0;
    }
    return true;
  })();

  const isLastTab = activeTab === questions.length - 1;

  return (
    <div className="max-w-full overflow-hidden text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        {!hideLabel && (
          <MessageCircleQuestion className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}
        {!hideLabel && <span className="font-medium text-foreground">{t('tools.question')}</span>}
        <span className="text-sm text-muted-foreground">
          {questions.length}{' '}
          {questions.length > 1 ? t('tools.questionsPlural') : t('tools.questions')}
        </span>
        {submitted && (
          <span className="ml-auto flex-shrink-0 rounded bg-status-success/10 px-1.5 py-0.5 text-xs font-medium text-status-success/80">
            {t('tools.answered')}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="border-t border-border/40">
        {questions.length > 1 && (
          <div className="flex gap-0 border-b border-border/40">
            {questions.map((q, i) => (
              <button
                key={q.header}
                onClick={() => setActiveTab(i)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium transition-colors relative',
                  i === activeTab
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground/80',
                )}
              >
                {q.header}
                {selections.get(i)?.size ? (
                  <Check className="ml-1 inline h-2.5 w-2.5 text-status-success/80" />
                ) : null}
                {i === activeTab && (
                  <div className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full bg-primary" />
                )}
              </button>
            ))}
          </div>
        )}

        {/* Active question */}
        <div className="space-y-2 px-3 py-2">
          <p className="text-xs leading-relaxed text-foreground">{activeQ.question}</p>

          {/* Options — use min-height from the tallest question to prevent layout shift (only when interactive) */}
          <div
            className="space-y-1"
            style={
              !submitted && maxContentHeight > 0
                ? { minHeight: `${maxContentHeight}px` }
                : undefined
            }
          >
            {activeQ.options.map((opt, oi) => {
              const isSelected = activeSelections.has(oi);
              return (
                <button
                  key={opt.label}
                  onClick={() => toggleOption(activeTab, oi, activeQ.multiSelect)}
                  disabled={submitted}
                  className={cn(
                    'flex items-start gap-2 w-full text-left rounded-md px-2.5 py-1.5 transition-colors border',
                    isSelected
                      ? 'border-primary/50 bg-primary/10'
                      : 'border-border/40 bg-background/50 hover:border-border hover:bg-accent/30',
                    submitted && 'opacity-70 cursor-default',
                  )}
                >
                  <div
                    className={cn(
                      'mt-0.5 flex-shrink-0 h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center',
                      activeQ.multiSelect && 'rounded-sm',
                      isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/40',
                    )}
                  >
                    {isSelected && <Check className="h-2 w-2 text-primary-foreground" />}
                  </div>
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-foreground">{opt.label}</span>
                    <p className="text-xs leading-snug text-muted-foreground">{opt.description}</p>
                  </div>
                </button>
              );
            })}

            {/* Other option */}
            <button
              onClick={() => toggleOption(activeTab, OTHER_INDEX, activeQ.multiSelect)}
              disabled={submitted}
              className={cn(
                'flex items-start gap-2 w-full text-left rounded-md px-2.5 py-1.5 transition-all border',
                isOtherSelected
                  ? 'border-primary bg-primary/10 ring-2 ring-primary/20'
                  : 'border-border/40 bg-background/50 hover:border-border hover:bg-accent/30',
                submitted && 'opacity-70 cursor-default',
              )}
            >
              <div
                className={cn(
                  'mt-0.5 flex-shrink-0 h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center',
                  activeQ.multiSelect && 'rounded-sm',
                  isOtherSelected ? 'border-primary bg-primary' : 'border-muted-foreground/40',
                )}
              >
                {isOtherSelected && <Check className="h-2 w-2 text-primary-foreground" />}
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <PenLine
                  className={cn(
                    'h-3 w-3 flex-shrink-0 transition-colors',
                    isOtherSelected ? 'text-primary' : 'text-muted-foreground',
                  )}
                />
                <span
                  className={cn(
                    'text-xs font-medium transition-colors',
                    isOtherSelected ? 'text-foreground' : 'text-foreground',
                  )}
                >
                  {t('tools.other')}
                </span>
              </div>
            </button>

            {/* Other text input */}
            {isOtherSelected && !submitted && (
              <textarea
                ref={otherInputRef}
                value={otherText}
                onChange={(e) =>
                  setOtherTexts((prev) => {
                    const next = new Map(prev);
                    next.set(activeTab, e.target.value);
                    return next;
                  })
                }
                placeholder={t('tools.otherPlaceholder')}
                className="min-h-[60px] w-full resize-none rounded-md border border-border/40 bg-background/50 px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
                rows={2}
              />
            )}
            {isOtherSelected && submitted && otherText.trim() && (
              <div className="rounded-md border border-border/40 bg-background/50 px-2.5 py-1.5 text-xs text-muted-foreground opacity-70">
                {otherText}
              </div>
            )}
          </div>

          {/* Action buttons */}
          {onRespond && !submitted && (
            <div className="flex items-center pt-1">
              {/* Continue button for "Other" option — shown when user needs to advance manually */}
              {isOtherSelected && !isLastTab && (
                <button
                  onClick={() => setActiveTab((prev) => prev + 1)}
                  disabled={!currentTabAnswered}
                  className={cn(
                    'flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                    currentTabAnswered
                      ? 'bg-primary/15 text-primary hover:bg-primary/25'
                      : 'bg-muted text-muted-foreground cursor-not-allowed',
                  )}
                >
                  {t('tools.continue')}
                  <ChevronRight className="h-3 w-3" />
                </button>
              )}

              {/* Submit button — bottom-right */}
              <button
                onClick={handleSubmit}
                disabled={!allAnswered}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ml-auto',
                  allAnswered
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed',
                )}
              >
                <Send className="h-3 w-3" />
                {t('tools.respond')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
