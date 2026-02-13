import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircleQuestion, Check, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getQuestions } from './utils';

export function AskQuestionCard({ parsed, onRespond, hideLabel }: { parsed: Record<string, unknown>; onRespond?: (answer: string) => void; hideLabel?: boolean }) {
  const { t } = useTranslation();
  const questions = getQuestions(parsed);
  if (!questions || questions.length === 0) return null;

  const [activeTab, setActiveTab] = useState(0);
  const [selections, setSelections] = useState<Map<number, Set<number>>>(() => new Map());
  const [submitted, setSubmitted] = useState(false);

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
  };

  const handleSubmit = () => {
    if (submitted || !onRespond) return;
    const parts: string[] = [];
    questions.forEach((q, qi) => {
      const selected = selections.get(qi);
      if (selected && selected.size > 0) {
        const answers = Array.from(selected).map((i) => {
          const opt = q.options[i];
          return opt ? `${opt.label} — ${opt.description}` : '';
        }).filter(Boolean);
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
  const allAnswered = questions.every((_, i) => (selections.get(i)?.size ?? 0) > 0);

  return (
    <div className="text-sm max-w-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        {!hideLabel && <MessageCircleQuestion className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
        {!hideLabel && <span className="font-medium text-foreground">{t('tools.question')}</span>}
        <span className="text-muted-foreground text-sm">
          {questions.length} {questions.length > 1 ? t('tools.questionsPlural') : t('tools.questions')}
        </span>
        {submitted && (
          <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-600 font-medium ml-auto">
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
                key={i}
                onClick={() => setActiveTab(i)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium transition-colors relative',
                  i === activeTab
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground/80'
                )}
              >
                {q.header}
                {selections.get(i)?.size ? (
                  <Check className="inline h-2.5 w-2.5 ml-1 text-green-500" />
                ) : null}
                {i === activeTab && (
                  <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-full" />
                )}
              </button>
            ))}
          </div>
        )}

        {/* Active question */}
        <div className="px-3 py-2 space-y-2 max-h-80 overflow-y-auto">
          <p className="text-xs text-foreground leading-relaxed">{activeQ.question}</p>

          {/* Options */}
          <div className="space-y-1">
            {activeQ.options.map((opt, oi) => {
              const isSelected = activeSelections.has(oi);
              return (
                <button
                  key={oi}
                  onClick={() => toggleOption(activeTab, oi, activeQ.multiSelect)}
                  disabled={submitted}
                  className={cn(
                    'flex items-start gap-2 w-full text-left rounded-md px-2.5 py-1.5 transition-colors border',
                    isSelected
                      ? 'border-primary/50 bg-primary/10'
                      : 'border-border/40 bg-background/50 hover:border-border hover:bg-accent/30',
                    submitted && 'opacity-70 cursor-default'
                  )}
                >
                  <div className={cn(
                    'mt-0.5 flex-shrink-0 h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center',
                    activeQ.multiSelect && 'rounded-sm',
                    isSelected
                      ? 'border-primary bg-primary'
                      : 'border-muted-foreground/40'
                  )}>
                    {isSelected && (
                      <Check className="h-2 w-2 text-primary-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-foreground">{opt.label}</span>
                    <p className="text-sm text-muted-foreground leading-snug">{opt.description}</p>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Submit button */}
          {onRespond && !submitted && (
            <div className="flex justify-end pt-1">
              <button
                onClick={handleSubmit}
                disabled={!allAnswered}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1 rounded-md text-sm font-medium transition-colors',
                  allAnswered
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
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
