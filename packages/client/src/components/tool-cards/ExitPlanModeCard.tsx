import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode2, CheckCircle2, XCircle, Send } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ExitPlanModeCard({ onRespond }: { onRespond?: (answer: string) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (onRespond && !submitted) {
      inputRef.current?.focus();
    }
  }, [onRespond, submitted]);

  const handleAccept = () => {
    if (!onRespond || submitted) return;
    onRespond('Plan accepted');
    setSubmitted(true);
  };

  const handleReject = () => {
    if (!onRespond || submitted) return;
    onRespond('Plan rejected. Do not proceed with this plan.');
    setSubmitted(true);
  };

  const handleSubmitInput = () => {
    const text = input.trim();
    if (!text || !onRespond || submitted) return;
    onRespond(text);
    setSubmitted(true);
  };

  return (
    <div className="text-sm max-w-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <FileCode2 className="h-3 w-3 flex-shrink-0 text-amber-400" />
        <span className="font-medium text-foreground">{t('tools.plan')}</span>
        <span className="text-muted-foreground">{t('thread.planWaitingForResponse')}</span>
        {submitted && (
          <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-600 font-medium ml-auto">
            {t('tools.answered')}
          </span>
        )}
      </div>

      {onRespond && !submitted && (
        <div className="border-t border-border/40 px-3 py-2.5 space-y-2">
          <div className="flex gap-2">
            <button
              onClick={handleAccept}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('tools.acceptPlan')}
            </button>
            <button
              onClick={handleReject}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
            >
              <XCircle className="h-3.5 w-3.5" />
              {t('thread.rejectPlan')}
            </button>
          </div>

          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmitInput();
                }
              }}
              placeholder={t('thread.waitingInputPlaceholder')}
              className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={handleSubmitInput}
              disabled={!input.trim()}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                input.trim()
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground cursor-not-allowed'
              )}
            >
              <Send className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
