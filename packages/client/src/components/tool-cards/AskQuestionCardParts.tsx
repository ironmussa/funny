import { Check, Send, PenLine, ChevronRight, Mic, MicOff, Loader2 } from 'lucide-react';
import type { ComponentProps, RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { PromptEditor } from '@/components/prompt-editor/PromptEditor';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { Question } from './utils';

/** Tab strip to switch between questions (only rendered for several questions). */
export function QuestionTabs({
  questions,
  activeTab,
  selections,
  onSelect,
}: {
  questions: Question[];
  activeTab: number;
  selections: Map<number, Set<number>>;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="border-border/40 flex gap-0 border-b">
      {questions.map((q, i) => (
        <button
          key={q.header}
          onClick={() => onSelect(i)}
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

/** One of the question's predefined options. */
export function QuestionOptionButton({
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
        isSelected
          ? 'border-primary/50 bg-primary/10'
          : 'border-border/40 bg-background/50 hover:border-border hover:bg-accent/30',
        submitted && 'opacity-70 cursor-default',
      )}
    >
      <div
        className={cn(
          'mt-0.5 shrink-0 size-3.5 rounded-full border-2 flex items-center justify-center',
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

/** The free-text "Other" option. */
export function OtherOptionButton({
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
          : 'border-border/40 bg-background/50 hover:border-border hover:bg-accent/30',
        submitted && 'opacity-70 cursor-default',
      )}
    >
      <div
        className={cn(
          'mt-0.5 shrink-0 size-3.5 rounded-full border-2 flex items-center justify-center',
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

/** Mic button for real-time dictation into the "Other" editor. */
function DictationButton({
  isRecording,
  isTranscribing,
  onToggle,
}: {
  isRecording: boolean;
  isTranscribing: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="border-border/20 flex items-center justify-end border-t px-1.5 py-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            data-testid="ask-question-dictate"
            onClick={onToggle}
            variant={isRecording ? 'ghost-destructive' : 'muted'}
            size="icon-sm"
            tabIndex={-1}
            aria-label={
              isRecording
                ? t('prompt.stopDictation', 'Stop dictation')
                : t('prompt.startDictation', 'Start dictation')
            }
            disabled={isTranscribing}
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

type PromptEditorProps = ComponentProps<typeof PromptEditor>;

/** Other text input — mini PromptEditor with @ mentions, / commands, and mic. */
export function OtherAnswerEditor({
  containerRef,
  editorRef,
  onEditorRef,
  onChange,
  onSubmit,
  cwd,
  slashSkills,
  slashSkillsLoading,
  onSlashOpen,
  hasAssemblyaiKey,
  isRecording,
  isTranscribing,
  onToggleRecording,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  editorRef: RefObject<PromptEditorHandle | null>;
  onEditorRef: (handle: PromptEditorHandle | null) => void;
  onChange: PromptEditorProps['onChange'];
  onSubmit: PromptEditorProps['onSubmit'];
  cwd: PromptEditorProps['cwd'];
  slashSkills: PromptEditorProps['slashSkills'];
  slashSkillsLoading: PromptEditorProps['slashSkillsLoading'];
  onSlashOpen: PromptEditorProps['onSlashOpen'];
  hasAssemblyaiKey: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  onToggleRecording: () => void;
}) {
  const { t } = useTranslation();
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
          onSlashOpen={onSlashOpen}
          className="max-h-[120px] min-h-[40px] overflow-y-auto text-sm"
        />
      </div>
      {hasAssemblyaiKey && (
        <DictationButton
          isRecording={isRecording}
          isTranscribing={isTranscribing}
          onToggle={onToggleRecording}
        />
      )}
    </div>
  );
}

/** Continue (for "Other") and Respond buttons. */
export function QuestionActions({
  showContinue,
  canContinue,
  onContinue,
  canSubmit,
  onSubmit,
}: {
  showContinue: boolean;
  canContinue: boolean;
  onContinue: () => void;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center pt-1">
      {/* Continue button for "Other" option — shown when user needs to advance manually */}
      {showContinue && (
        <button
          onClick={onContinue}
          disabled={!canContinue}
          className={cn(
            'flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
            canContinue
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
        onClick={onSubmit}
        disabled={!canSubmit}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ml-auto',
          canSubmit
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
