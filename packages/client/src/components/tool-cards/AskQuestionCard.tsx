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
import { useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';

import { PromptEditor } from '@/components/prompt-editor/PromptEditor';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';

import { OTHER_INDEX, useQuestionAnswers } from './use-question-answers';
import { useThreadSlashSkills } from './use-thread-slash-skills';
import { getQuestions, type Question } from './utils';

const cardLog = createClientLogger('AskUserQuestion');

type QuestionAnswers = ReturnType<typeof useQuestionAnswers>;
type Dictation = QuestionAnswers['dictation'];

const OPTION_UNSELECTED_CLASS =
  'border-border/40 bg-background/50 hover:border-border hover:bg-accent/30';
const OPTION_INDICATOR_CLASS =
  'mt-0.5 shrink-0 size-3.5 rounded-full border-2 flex items-center justify-center';

function QuestionCardHeader({
  questionCount,
  hideLabel,
  displayTime,
  submitted,
}: {
  questionCount: number;
  hideLabel?: boolean;
  displayTime?: string | null;
  submitted: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      {!hideLabel && <MessageCircleQuestion className="icon-xs text-muted-foreground shrink-0" />}
      {!hideLabel && <span className="text-foreground font-medium">{t('tools.question')}</span>}
      <span className="text-muted-foreground text-sm">
        {questionCount} {questionCount > 1 ? t('tools.questionsPlural') : t('tools.questions')}
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
  );
}

function QuestionTabBar({
  questions,
  activeTab,
  selections,
  goToTab,
}: {
  questions: Question[];
  activeTab: number;
  selections: Map<number, Set<number>>;
  goToTab: (tab: number) => void;
}) {
  return (
    <div className="border-border/40 flex gap-0 border-b">
      {questions.map((q, i) => (
        <button
          key={q.header}
          onClick={() => goToTab(i)}
          className={cn(
            'px-3 py-1.5 text-sm font-medium transition-colors relative',
            i === activeTab ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/80',
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
  );
}

function QuestionOption({
  label,
  description,
  isSelected,
  multiSelect,
  submitted,
  onClick,
}: {
  label: string;
  description: string;
  isSelected: boolean;
  multiSelect: boolean;
  submitted: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={submitted}
      className={cn(
        'flex items-start gap-2 w-full text-left rounded-md px-2.5 py-1.5 transition-colors border',
        isSelected ? 'border-primary/50 bg-primary/10' : OPTION_UNSELECTED_CLASS,
        submitted && 'opacity-70 cursor-default',
      )}
    >
      <div
        className={cn(
          OPTION_INDICATOR_CLASS,
          multiSelect && 'rounded-sm',
          isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/40',
        )}
      >
        {isSelected && <Check className="text-primary-foreground size-2" />}
      </div>
      <div className="min-w-0">
        <span className="text-foreground text-xs font-medium">{label}</span>
        <p className="text-muted-foreground text-xs leading-snug">{description}</p>
      </div>
    </button>
  );
}

function OtherOption({
  isSelected,
  multiSelect,
  submitted,
  onClick,
}: {
  isSelected: boolean;
  multiSelect: boolean;
  submitted: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      disabled={submitted}
      className={cn(
        'flex items-start gap-2 w-full text-left rounded-md px-2.5 py-1.5 transition-all border',
        isSelected
          ? 'border-primary bg-primary/10 ring-2 ring-primary/20'
          : OPTION_UNSELECTED_CLASS,
        submitted && 'opacity-70 cursor-default',
      )}
    >
      <div
        className={cn(
          OPTION_INDICATOR_CLASS,
          multiSelect && 'rounded-sm',
          isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/40',
        )}
      >
        {isSelected && <Check className="text-primary-foreground size-2" />}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <PenLine
          className={cn(
            'icon-xs shrink-0 transition-colors',
            isSelected ? 'text-primary' : 'text-muted-foreground',
          )}
        />
        <span
          className={cn(
            'text-xs font-medium transition-colors',
            isSelected ? 'text-foreground' : 'text-foreground',
          )}
        >
          {t('tools.other')}
        </span>
      </div>
    </button>
  );
}

function DictationButton({ dictation }: { dictation: Dictation }) {
  const { t } = useTranslation();
  const { isRecording, isTranscribing, toggleRecording } = dictation;
  return (
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
  );
}

/** Other text input — mini PromptEditor with @ mentions, / commands, and mic */
function OtherAnswerEditor({
  containerRef,
  editorRef,
  onEditorRef,
  onChange,
  onSubmit,
  dictation,
}: {
  containerRef: QuestionAnswers['otherEditorContainerRef'];
  editorRef: QuestionAnswers['otherEditorRef'];
  onEditorRef: QuestionAnswers['handleOtherEditorRef'];
  onChange: () => void;
  onSubmit: () => void;
  dictation: Dictation;
}) {
  const { t } = useTranslation();
  // ── Skills for slash commands (lazy: only fetched on the first `/`). ──
  const { cwd, slashSkills, slashSkillsLoading, ensureSlashSkills } = useThreadSlashSkills();

  return (
    // Padding clicks forward focus to the nested editor; the wrapper is not an input itself.
    // react-doctor-disable-next-line react-doctor/no-static-element-interactions
    <div
      ref={containerRef}
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        // Mic and editor handle their own focus — don't interfere
        if (target.closest('[data-testid="ask-question-dictate"]')) return;
        if (target.closest('[data-testid="prompt-editor"]')) return;
        // Clicked padding/border — route caret into the input
        e.preventDefault();
        editorRef.current?.focus();
      }}
      className="border-border/40 bg-background/50 focus-within:border-ring focus-within:ring-ring/50 rounded-md border focus-within:ring-1"
    >
      <div className="px-2.5 py-1.5">
        <PromptEditor
          ref={onEditorRef}
          placeholder={t('tools.otherPlaceholder')}
          onChange={onChange}
          onSubmit={onSubmit}
          cwd={cwd}
          slashSkills={slashSkills}
          slashSkillsLoading={slashSkillsLoading}
          onSlashOpen={ensureSlashSkills}
          className="max-h-[120px] min-h-[40px] overflow-y-auto text-sm"
        />
      </div>
      {dictation.hasAssemblyaiKey && <DictationButton dictation={dictation} />}
    </div>
  );
}

function QuestionActions({
  answers,
  isOtherSelected,
}: {
  answers: QuestionAnswers;
  isOtherSelected: boolean;
}) {
  const { t } = useTranslation();
  const { activeTab, isLastTab, currentTabAnswered, allAnswered } = answers;
  return (
    <div className="flex items-center pt-1">
      {/* Continue button for "Other" option — shown when user needs to advance manually */}
      {isOtherSelected && !isLastTab && (
        <button
          onClick={() => answers.goToTab(activeTab + 1)}
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
        onClick={answers.handleSubmit}
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
  );
}

/** The "Other" answer: its editor while interactive, its text once submitted. */
function OtherAnswer({ answers }: { answers: QuestionAnswers }) {
  if (!answers.submitted) {
    return (
      <OtherAnswerEditor
        containerRef={answers.otherEditorContainerRef}
        editorRef={answers.otherEditorRef}
        onEditorRef={answers.handleOtherEditorRef}
        onChange={answers.handleOtherEditorChange}
        onSubmit={answers.handleOtherSubmit}
        dictation={answers.dictation}
      />
    );
  }
  const otherText = answers.otherTexts.get(answers.activeTab) || '';
  if (!otherText.trim()) return null;
  return (
    <div className="border-border/40 bg-background/50 text-muted-foreground rounded-md border px-2.5 py-1.5 text-xs opacity-70">
      {otherText}
    </div>
  );
}

/** The options of the active question, with the "Other" answer and its editor. */
function QuestionOptions({ question, answers }: { question: Question; answers: QuestionAnswers }) {
  const { activeTab, submitted, maxContentHeight, toggleOption } = answers;
  const activeSelections = answers.selections.get(activeTab) || new Set<number>();
  const isOtherSelected = activeSelections.has(OTHER_INDEX);
  return (
    // Options — use min-height from the tallest question to prevent layout shift (only when interactive)
    <div
      className="space-y-1"
      style={
        !submitted && maxContentHeight > 0 ? { minHeight: `${maxContentHeight}px` } : undefined
      }
    >
      {question.options.map((opt, oi) => (
        <QuestionOption
          key={opt.label}
          label={opt.label}
          description={opt.description}
          isSelected={activeSelections.has(oi)}
          multiSelect={question.multiSelect}
          submitted={submitted}
          onClick={() => toggleOption(activeTab, oi, question.multiSelect)}
        />
      ))}

      <OtherOption
        isSelected={isOtherSelected}
        multiSelect={question.multiSelect}
        submitted={submitted}
        onClick={() => toggleOption(activeTab, OTHER_INDEX, question.multiSelect)}
      />

      {isOtherSelected && <OtherAnswer answers={answers} />}
    </div>
  );
}

function useSlideVariants() {
  const prefersReducedMotion = useReducedMotion();
  return {
    variants: {
      enter: (dir: number) => ({
        x: prefersReducedMotion ? 0 : dir >= 0 ? 24 : -24,
        opacity: prefersReducedMotion ? 1 : 0,
      }),
      center: { x: 0, opacity: 1 },
      exit: (dir: number) => ({
        x: prefersReducedMotion ? 0 : dir >= 0 ? -24 : 24,
        opacity: prefersReducedMotion ? 1 : 0,
      }),
    },
    transition: { duration: prefersReducedMotion ? 0 : 0.18, ease: 'easeOut' as const },
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
  const questions = useMemo(() => getQuestions(parsed) ?? [], [parsed]);

  cardLog.info('render', {
    questionCount: String(questions.length),
    hasOnRespond: String(!!onRespond),
    hasOutput: String(!!output),
  });

  const answers = useQuestionAnswers(questions, output, onRespond);
  const { rawAnswerFallback, activeTab, slideDirection, submitted } = answers;
  const { variants, transition } = useSlideVariants();

  if (questions.length === 0) return null;

  const activeQ = questions[activeTab];
  const isOtherSelected = answers.selections.get(activeTab)?.has(OTHER_INDEX) ?? false;

  return (
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-sm">
      <QuestionCardHeader
        questionCount={questions.length}
        hideLabel={hideLabel}
        displayTime={displayTime}
        submitted={submitted}
      />

      {/* Tabs */}
      <div className="border-border/40 border-t">
        {!rawAnswerFallback && questions.length > 1 && (
          <QuestionTabBar
            questions={questions}
            activeTab={activeTab}
            selections={answers.selections}
            goToTab={answers.goToTab}
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
                variants={variants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={transition}
                className="space-y-2 px-3 py-2"
              >
                <p className="text-foreground text-xs leading-relaxed">{activeQ.question}</p>

                <QuestionOptions question={activeQ} answers={answers} />

                {/* Action buttons */}
                {onRespond && !submitted && (
                  <QuestionActions answers={answers} isOtherSelected={isOtherSelected} />
                )}
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
});
