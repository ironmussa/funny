import { MessageCircleQuestion } from 'lucide-react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useState, useRef, useEffect, useMemo, useCallback, useReducer, memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { reduceQuestionTab } from '@/components/tool-cards/question-tab-state';
import { useEditorDictation } from '@/hooks/use-editor-dictation';
import { useSlashSkills } from '@/hooks/use-slash-skills';
import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';

import {
  OtherAnswerEditor,
  OtherOptionButton,
  QuestionActions,
  QuestionOptionButton,
  QuestionTabs,
} from './AskQuestionCardParts';
import {
  getQuestions,
  useCurrentProjectId,
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
/** The options picked per question index, and any free "Other" text. */
interface ParsedSelections {
  selections: Map<number, Set<number>>;
  otherTexts: Map<number, string>;
}

function parseOutputToSelections(output: string, questions: Question[]): ParsedSelections {
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

/** Returns a copy of `selections` with `optIndex` toggled for question `qIndex`. */
function toggleSelection(
  selections: Map<number, Set<number>>,
  qIndex: number,
  optIndex: number,
  multiSelect: boolean,
): Map<number, Set<number>> {
  const next = new Map(selections);
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
}

/** Whether question `qIndex` has an answer ("Other" alone requires text). */
function isQuestionAnswered(
  selections: Map<number, Set<number>>,
  otherTexts: Map<number, string>,
  qIndex: number,
): boolean {
  const sel = selections.get(qIndex);
  if (!sel || sel.size === 0) return false;
  // If "Other" is the only selection, require text
  if (sel.has(OTHER_INDEX) && sel.size === 1) {
    return (otherTexts.get(qIndex)?.trim().length ?? 0) > 0;
  }
  return true;
}

/** Formats the selected answers into the response text sent to the agent. */
function buildAnswerText(
  questions: Question[],
  selections: Map<number, Set<number>>,
  otherTexts: Map<number, string>,
  otherLabel: string,
): string {
  const parts: string[] = [];
  questions.forEach((q, qi) => {
    const selected = selections.get(qi);
    if (selected && selected.size > 0) {
      const answers = Array.from(selected).flatMap((i) => {
        if (i === OTHER_INDEX) {
          const text = otherTexts.get(qi)?.trim();
          return text ? [`${otherLabel} — ${text}`] : [];
        }
        const opt = q.options[i];
        return opt ? [`${opt.label} — ${opt.description}`] : [];
      });
      parts.push(`[${q.header}] ${q.question}\n→ ${answers.join('\n→ ')}`);
    }
  });
  return parts.join('\n\n');
}

/** Max height needed across all tabs (including "Other" option and textarea). */
function computeMaxContentHeight(
  questions: Question[],
  selections: Map<number, Set<number>>,
): number {
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
}

function slideVariants(prefersReducedMotion: boolean | null) {
  return {
    enter: (dir: number) => ({
      x: prefersReducedMotion ? 0 : dir >= 0 ? 24 : -24,
      opacity: prefersReducedMotion ? 1 : 0,
    }),
    center: { x: 0, opacity: 1 },
    exit: (dir: number) => ({
      x: prefersReducedMotion ? 0 : dir >= 0 ? -24 : 24,
      opacity: prefersReducedMotion ? 1 : 0,
    }),
  };
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

  const [{ activeTab, slideDirection }, goToTab] = useReducer(reduceQuestionTab, {
    activeTab: 0,
    slideDirection: 0,
  });
  const prefersReducedMotion = useReducedMotion();
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
  const projectId = useCurrentProjectId();
  const { provider: threadProvider, model: threadModel } = useCurrentThreadProviderModel();

  // ── Dictation (real-time voice-to-text via AssemblyAI) ──
  const { hasAssemblyaiKey, isRecording, isTranscribing, toggleRecording, stopRecording } =
    useEditorDictation(otherEditorRef, otherEditorContainerRef);

  // ── Skills for slash commands (single cache; lazy — these cards mount in
  // bulk and most are never typed into, so only fetch on the first `/`). ──
  const { slashSkills, slashSkillsLoading, ensureSlashSkills } = useSlashSkills({
    projectPath: cwd,
    projectId,
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
  // editor exists. The callback is recreated for committed tab state, so it
  // never depends on mutating refs during render.
  const handleOtherEditorRef = useCallback(
    (handle: PromptEditorHandle | null) => {
      otherEditorRef.current = handle;
      if (!handle) return;
      const savedText = otherTexts.get(activeTab) || '';
      if (savedText) handle.setContent(savedText);
    },
    [activeTab, otherTexts],
  );

  const toggleOption = (qIndex: number, optIndex: number, multiSelect: boolean) => {
    if (submitted) return;
    setSelections((prev) => toggleSelection(prev, qIndex, optIndex, multiSelect));

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
    const answer = buildAnswerText(questions, selections, otherTexts, t('tools.other'));
    if (answer) {
      cardLog.info('response submitted', { answerPreview: answer.slice(0, 200) });
      onRespond(answer);
      setSubmitted(true);
    }
  };

  const activeQ = questions[activeTab];
  const activeSelections = selections.get(activeTab) || new Set<number>();
  const isOtherSelected = activeSelections.has(OTHER_INDEX);
  const otherText = otherTexts.get(activeTab) || '';

  const maxContentHeight = useMemo(
    () => computeMaxContentHeight(questions, selections),
    [questions, selections],
  );

  const allAnswered = questions.every((_, i) => isQuestionAnswered(selections, otherTexts, i));
  const currentTabAnswered = isQuestionAnswered(selections, otherTexts, activeTab);

  const isLastTab = activeTab === questions.length - 1;

  const handleOtherEditorSubmit = () => {
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
  };

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
          <span className="text-muted-foreground/50 text-2xs tabular-nums">{displayTime}</span>
        )}
        {submitted && (
          <span className="bg-status-success/10 text-status-success/80 ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs font-medium">
            {t('tools.answered')}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="border-border/40 border-t">
        {!rawAnswerFallback && questions.length > 1 && (
          <QuestionTabs
            questions={questions}
            activeTab={activeTab}
            selections={selections}
            onSelect={goToTab}
          />
        )}

        {/* AnimatePresence remains mounted so both tab changes and fallback transitions can exit. */}
        <div className="relative overflow-hidden">
          <AnimatePresence mode="wait" initial={false} custom={slideDirection}>
            {rawAnswerFallback ? (
              <m.div key="raw-answer" className="px-3 py-2">
                <p className="text-foreground text-xs leading-relaxed">{questions[0]?.question}</p>
                <div className="border-border/40 bg-background/50 text-muted-foreground mt-1.5 rounded-md border px-2.5 py-1.5 text-xs">
                  {rawAnswerFallback}
                </div>
              </m.div>
            ) : (
              <m.div
                key={activeTab}
                custom={slideDirection}
                variants={slideVariants(prefersReducedMotion)}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: prefersReducedMotion ? 0 : 0.18, ease: 'easeOut' }}
                className="space-y-2 px-3 py-2"
              >
                <p className="text-foreground text-xs leading-relaxed">{activeQ.question}</p>

                {/* Options — use min-height from the tallest question to prevent layout shift (only when interactive) */}
                <div
                  className={cn(
                    'space-y-1',
                    !submitted &&
                      maxContentHeight > 0 &&
                      'min-h-[var(--ask-question-options-min-height)]',
                  )}
                  style={{ '--ask-question-options-min-height': `${maxContentHeight}px` }}
                >
                  {activeQ.options.map((opt, oi) => {
                    const isSelected = activeSelections.has(oi);
                    return (
                      <QuestionOptionButton
                        key={opt.label}
                        label={opt.label}
                        description={opt.description}
                        isSelected={isSelected}
                        multiSelect={activeQ.multiSelect}
                        submitted={submitted}
                        onClick={() => toggleOption(activeTab, oi, activeQ.multiSelect)}
                      />
                    );
                  })}

                  {/* Other option */}
                  <OtherOptionButton
                    isSelected={isOtherSelected}
                    multiSelect={activeQ.multiSelect}
                    submitted={submitted}
                    onClick={() => toggleOption(activeTab, OTHER_INDEX, activeQ.multiSelect)}
                  />

                  {/* Other text input — mini PromptEditor with @ mentions, / commands, and mic */}
                  {isOtherSelected && !submitted && (
                    <OtherAnswerEditor
                      containerRef={otherEditorContainerRef}
                      editorRef={otherEditorRef}
                      onEditorRef={handleOtherEditorRef}
                      onChange={handleOtherEditorChange}
                      onSubmit={handleOtherEditorSubmit}
                      cwd={cwd}
                      slashSkills={slashSkills}
                      slashSkillsLoading={slashSkillsLoading}
                      onSlashOpen={ensureSlashSkills}
                      hasAssemblyaiKey={hasAssemblyaiKey}
                      isRecording={isRecording}
                      isTranscribing={isTranscribing}
                      onToggleRecording={toggleRecording}
                    />
                  )}
                  {isOtherSelected && submitted && otherText.trim() && (
                    <div className="border-border/40 bg-background/50 text-muted-foreground rounded-md border px-2.5 py-1.5 text-xs opacity-70">
                      {otherText}
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                {onRespond && !submitted && (
                  <QuestionActions
                    showContinue={isOtherSelected && !isLastTab}
                    canContinue={currentTabAnswered}
                    onContinue={() => goToTab(activeTab + 1)}
                    canSubmit={allAnswered}
                    onSubmit={handleSubmit}
                  />
                )}
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
});
