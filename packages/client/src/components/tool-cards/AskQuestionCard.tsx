import {
  MessageCircleQuestion,
  Check,
  Send,
  PenLine,
  ChevronRight,
  Mic,
  MicOff,
  Loader2,
} from 'lucide-react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useState, useRef, useEffect, useMemo, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { PromptEditor } from '@/components/prompt-editor/PromptEditor';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDictation } from '@/hooks/use-dictation';
import { usePushToTalk } from '@/hooks/use-push-to-talk';
import { useSlashSkills } from '@/hooks/use-slash-skills';
import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';
import { useProfileStore } from '@/stores/profile-store';

import {
  getQuestions,
  useCurrentProjectPath,
  useCurrentThreadProviderModel,
  type Question,
} from './utils';

const cardLog = createClientLogger('AskUserQuestion');

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

export const AskQuestionCard = memo(function AskQuestionCard({
  parsed,
  onRespond,
  output,
  hideLabel,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  onRespond?: (answer: string) => void;
  output?: string;
  hideLabel?: boolean;
  displayTime?: string | null;
}) {
  const { t } = useTranslation();
  const questions = useMemo(() => getQuestions(parsed) ?? [], [parsed]);
  const hasQuestions = questions.length > 0;

  cardLog.info('render', {
    questionCount: String(questions.length),
    hasOnRespond: String(!!onRespond),
    hasOutput: String(!!output),
  });

  const alreadyAnswered = !!output;
  // Parse existing output back into selections for read-only display
  const restoredState = useMemo(() => {
    if (!alreadyAnswered) return null;
    return parseOutputToSelections(output!, questions);
  }, [alreadyAnswered, output, questions]);

  // When output exists but nothing could be parsed back into selections,
  // show the raw answer text as a fallback (e.g. user typed directly in chat input).
  const rawAnswerFallback = useMemo(() => {
    if (!alreadyAnswered) return null;
    if (restoredState && restoredState.selections.size > 0) return null;
    return output!;
  }, [alreadyAnswered, restoredState, output]);

  const [activeTab, setActiveTab] = useState(0);
  const [slideDirection, setSlideDirection] = useState(0);
  const prefersReducedMotion = useReducedMotion();

  const goToTab = useCallback((nextTab: number) => {
    setActiveTab((prev) => {
      if (nextTab === prev) return prev;
      setSlideDirection(nextTab > prev ? 1 : -1);
      return nextTab;
    });
  }, []);
  const [selections, setSelections] = useState<Map<number, Set<number>>>(
    () => restoredState?.selections ?? new Map(),
  );
  const [submitted, setSubmitted] = useState(alreadyAnswered);
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(
    () => restoredState?.otherTexts ?? new Map(),
  );
  const otherEditorRef = useRef<PromptEditorHandle>(null);
  const otherEditorContainerRef = useRef<HTMLDivElement>(null);
  const cwd = useCurrentProjectPath();
  const { provider: threadProvider, model: threadModel } = useCurrentThreadProviderModel();

  // ── Dictation (real-time voice-to-text via AssemblyAI) ──
  const hasAssemblyaiKey = useProfileStore((s) => s.profile?.hasAssemblyaiKey ?? false);
  const partialTextRef = useRef('');

  const handlePartialTranscript = useCallback((text: string) => {
    partialTextRef.current = text;
    if (text) otherEditorRef.current?.setDictationPreview(text);
  }, []);

  const handleFinalTranscript = useCallback((text: string) => {
    if (text) otherEditorRef.current?.commitDictation(text);
    partialTextRef.current = '';
  }, []);

  const handleDictationError = useCallback(
    (message: string) => {
      toast.error(message || t('prompt.micPermissionDenied', 'Microphone access denied'));
    },
    [t],
  );

  const {
    isRecording,
    isConnecting: isTranscribing,
    start: startRecording,
    toggle: toggleRecording,
    stop: stopRecording,
  } = useDictation({
    onPartial: handlePartialTranscript,
    onFinal: handleFinalTranscript,
    onError: handleDictationError,
  });

  usePushToTalk({
    enabled: hasAssemblyaiKey,
    containerRef: otherEditorContainerRef,
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
  });

  // ── Skills for slash commands (single cache; lazy — these cards mount in
  // bulk and most are never typed into, so only fetch on the first `/`). ──
  const { slashSkills, slashSkillsLoading, ensureSlashSkills } = useSlashSkills({
    projectPath: cwd,
    provider: threadProvider,
    model: threadModel,
    mode: 'lazy',
  });

  // Sync editor content → otherTexts state
  const handleOtherEditorChange = useCallback(() => {
    const text = otherEditorRef.current?.getText() ?? '';
    setOtherTexts((prev) => {
      const next = new Map(prev);
      next.set(activeTab, text);
      return next;
    });
  }, [activeTab]);

  // Restore editor content on mount via callback ref. The PromptEditor lives
  // inside an AnimatePresence(mode="wait") subtree keyed by activeTab, so it
  // remounts on every tab switch — a regular effect would run before the new
  // editor exists. Reading current state via refs keeps the callback stable.
  const otherTextsRef = useRef(otherTexts);
  otherTextsRef.current = otherTexts;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const handleOtherEditorRef = useCallback((handle: PromptEditorHandle | null) => {
    otherEditorRef.current = handle;
    if (!handle) return;
    const savedText = otherTextsRef.current.get(activeTabRef.current) || '';
    if (savedText) handle.setContent(savedText);
  }, []);

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

    if (optIndex === OTHER_INDEX) {
      // Always move caret into the input when "Other" is pressed
      setTimeout(() => otherEditorRef.current?.focus(), 0);
      return;
    }

    // Auto-advance to next question if:
    // - Not multi-select (single selection)
    // - Not on the last question
    if (!multiSelect && qIndex < questions.length - 1) {
      // Use setTimeout to ensure state update completes before advancing
      setTimeout(() => goToTab(qIndex + 1), 150);
    }
  };

  // Focus the editor when "Other" is selected
  useEffect(() => {
    const activeSelections = selections.get(activeTab);
    if (activeSelections?.has(OTHER_INDEX) && otherEditorRef.current) {
      otherEditorRef.current.focus();
    }
  }, [selections, activeTab]);

  const handleSubmit = () => {
    if (submitted || !onRespond) return;
    if (isRecording) stopRecording();
    const parts: string[] = [];
    questions.forEach((q, qi) => {
      const selected = selections.get(qi);
      if (selected && selected.size > 0) {
        const answers = Array.from(selected).flatMap((i) => {
          if (i === OTHER_INDEX) {
            const text = otherTexts.get(qi)?.trim();
            return text ? [`${t('tools.other')} — ${text}`] : [];
          }
          const opt = q.options[i];
          return opt ? [`${opt.label} — ${opt.description}`] : [];
        });
        parts.push(`[${q.header}] ${q.question}\n→ ${answers.join('\n→ ')}`);
      }
    });
    if (parts.length > 0) {
      const answer = parts.join('\n\n');
      cardLog.info('response submitted', { answerPreview: answer.slice(0, 200) });
      onRespond(answer);
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

  if (!hasQuestions) return null;

  return (
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        {!hideLabel && <MessageCircleQuestion className="icon-xs text-muted-foreground shrink-0" />}
        {!hideLabel && <span className="text-foreground font-medium">{t('tools.question')}</span>}
        <span className="text-muted-foreground text-sm">
          {questions.length}{' '}
          {questions.length > 1 ? t('tools.questionsPlural') : t('tools.questions')}
        </span>
        {displayTime && (
          <span className="text-muted-foreground/50 text-[10px] tabular-nums">{displayTime}</span>
        )}
        {submitted && (
          <span className="bg-status-success/10 text-status-success/80 ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs font-medium">
            {t('tools.answered')}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="border-border/40 border-t">
        {/* Fallback: when output exists but couldn't be parsed into selections, show the raw answer */}
        {rawAnswerFallback ? (
          <div className="px-3 py-2">
            <p className="text-foreground text-xs leading-relaxed">{questions[0]?.question}</p>
            <div className="border-border/40 bg-background/50 text-muted-foreground mt-1.5 rounded-md border px-2.5 py-1.5 text-xs">
              {rawAnswerFallback}
            </div>
          </div>
        ) : (
          <>
            {questions.length > 1 && (
              <div className="border-border/40 flex gap-0 border-b">
                {questions.map((q, i) => (
                  <button
                    key={q.header}
                    onClick={() => goToTab(i)}
                    className={cn(
                      'px-3 py-1.5 text-sm font-medium transition-colors relative',
                      i === activeTab
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground/80',
                    )}
                  >
                    {q.header}
                    {selections.get(i)?.size ? (
                      <Check className="icon-2xs text-status-success/80 ml-1 inline" />
                    ) : null}
                    {i === activeTab && (
                      <div className="bg-primary absolute right-0 bottom-0 left-0 h-[2px] rounded-full" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Active question — vertical slide between tabs */}
            <div className="relative overflow-hidden">
              <AnimatePresence mode="wait" initial={false} custom={slideDirection}>
                <m.div
                  key={activeTab}
                  custom={slideDirection}
                  variants={{
                    enter: (dir: number) => ({
                      x: prefersReducedMotion ? 0 : dir >= 0 ? 24 : -24,
                      opacity: prefersReducedMotion ? 1 : 0,
                    }),
                    center: { x: 0, opacity: 1 },
                    exit: (dir: number) => ({
                      x: prefersReducedMotion ? 0 : dir >= 0 ? -24 : 24,
                      opacity: prefersReducedMotion ? 1 : 0,
                    }),
                  }}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: prefersReducedMotion ? 0 : 0.18, ease: 'easeOut' }}
                  className="space-y-2 px-3 py-2"
                >
                  <p className="text-foreground text-xs leading-relaxed">{activeQ.question}</p>

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
                              'mt-0.5 shrink-0 size-3.5 rounded-full border-2 flex items-center justify-center',
                              activeQ.multiSelect && 'rounded-sm',
                              isSelected
                                ? 'border-primary bg-primary'
                                : 'border-muted-foreground/40',
                            )}
                          >
                            {isSelected && <Check className="text-primary-foreground size-2" />}
                          </div>
                          <div className="min-w-0">
                            <span className="text-foreground text-xs font-medium">{opt.label}</span>
                            <p className="text-muted-foreground text-xs leading-snug">
                              {opt.description}
                            </p>
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
                          'mt-0.5 shrink-0 size-3.5 rounded-full border-2 flex items-center justify-center',
                          activeQ.multiSelect && 'rounded-sm',
                          isOtherSelected
                            ? 'border-primary bg-primary'
                            : 'border-muted-foreground/40',
                        )}
                      >
                        {isOtherSelected && <Check className="text-primary-foreground size-2" />}
                      </div>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <PenLine
                          className={cn(
                            'icon-xs shrink-0 transition-colors',
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

                    {/* Other text input — mini PromptEditor with @ mentions, / commands, and mic */}
                    {isOtherSelected && !submitted && (
                      <div
                        ref={otherEditorContainerRef}
                        onMouseDown={(e) => {
                          const target = e.target as HTMLElement;
                          // Mic and editor handle their own focus — don't interfere
                          if (target.closest('[data-testid="ask-question-dictate"]')) return;
                          if (target.closest('[data-testid="prompt-editor"]')) return;
                          // Clicked padding/border — route caret into the input
                          e.preventDefault();
                          otherEditorRef.current?.focus();
                        }}
                        className="border-border/40 bg-background/50 focus-within:border-ring focus-within:ring-ring/50 rounded-md border focus-within:ring-1"
                      >
                        <div className="px-2.5 py-1.5">
                          <PromptEditor
                            ref={handleOtherEditorRef}
                            placeholder={t('tools.otherPlaceholder')}
                            onChange={handleOtherEditorChange}
                            onSubmit={() => {
                              // Flush editor text to state before submitting
                              const text = otherEditorRef.current?.getText() ?? '';
                              setOtherTexts((prev) => {
                                const next = new Map(prev);
                                next.set(activeTab, text);
                                return next;
                              });
                              if (isLastTab || questions.length === 1) {
                                // Use setTimeout to let state update flush before handleSubmit reads it
                                setTimeout(handleSubmit, 0);
                              } else {
                                goToTab(activeTab + 1);
                              }
                            }}
                            cwd={cwd}
                            slashSkills={slashSkills}
                            slashSkillsLoading={slashSkillsLoading}
                            onSlashOpen={ensureSlashSkills}
                            className="max-h-[120px] min-h-[40px] overflow-y-auto text-sm"
                          />
                        </div>
                        {hasAssemblyaiKey && (
                          <div className="border-border/20 flex items-center justify-end border-t px-1.5 py-0.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  data-testid="ask-question-dictate"
                                  onClick={toggleRecording}
                                  variant="ghost"
                                  size="icon-sm"
                                  tabIndex={-1}
                                  aria-label={
                                    isRecording
                                      ? t('prompt.stopDictation', 'Stop dictation')
                                      : t('prompt.startDictation', 'Start dictation')
                                  }
                                  disabled={isTranscribing}
                                  className={cn(
                                    'text-muted-foreground hover:text-foreground',
                                    isRecording && 'text-destructive hover:text-destructive',
                                  )}
                                >
                                  {isTranscribing ? (
                                    <Loader2 className="icon-xs animate-spin" />
                                  ) : isRecording ? (
                                    <MicOff className="icon-xs" />
                                  ) : (
                                    <Mic className="icon-xs" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {isTranscribing
                                  ? t('prompt.transcribing', 'Transcribing...')
                                  : isRecording
                                    ? t('prompt.stopDictation', 'Stop dictation')
                                    : t('prompt.startDictation', 'Start dictation')}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        )}
                      </div>
                    )}
                    {isOtherSelected && submitted && otherText.trim() && (
                      <div className="border-border/40 bg-background/50 text-muted-foreground rounded-md border px-2.5 py-1.5 text-xs opacity-70">
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
                          onClick={() => goToTab(activeTab + 1)}
                          disabled={!currentTabAnswered}
                          className={cn(
                            'flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                            currentTabAnswered
                              ? 'bg-primary/15 text-primary hover:bg-primary/25'
                              : 'bg-muted text-muted-foreground cursor-not-allowed',
                          )}
                        >
                          {t('tools.continue')}
                          <ChevronRight className="icon-xs" />
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
                        <Send className="icon-xs" />
                        {t('tools.respond')}
                      </button>
                    </div>
                  )}
                </m.div>
              </AnimatePresence>
            </div>
          </>
        )}
      </div>
    </div>
  );
});
