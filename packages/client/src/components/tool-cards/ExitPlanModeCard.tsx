import { FileCode2, CheckCircle2, XCircle, Send } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function ExitPlanModeCard({
  plan,
  onRespond,
  output,
}: {
  plan?: string;
  onRespond?: (answer: string) => void;
  output?: string;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const alreadyAnswered = !!output;
  const [submitted, setSubmitted] = useState(alreadyAnswered);
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
    <div className="max-w-full overflow-hidden text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <FileCode2 className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{t('tools.plan')}</span>
        {!submitted && (
          <span className="text-muted-foreground">{t('thread.planWaitingForResponse')}</span>
        )}
        {submitted && (
          <span className="ml-auto flex-shrink-0 rounded bg-status-success/10 px-1.5 py-0.5 text-xs font-medium text-status-success/80">
            {t('tools.answered')}
          </span>
        )}
      </div>

      {plan && (
        <div className="max-h-[500px] overflow-y-auto border-t border-border/40 px-4 py-3">
          <div className="prose prose-xs prose-invert prose-headings:text-foreground prose-headings:font-semibold prose-h1:text-xs prose-h1:mb-1.5 prose-h1:mt-0 prose-h2:text-xs prose-h2:mb-1 prose-h2:mt-2.5 prose-h3:text-sm prose-h3:mb-1 prose-h3:mt-2 prose-p:text-xs prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:my-0.5 prose-li:text-sm prose-li:text-muted-foreground prose-li:leading-relaxed prose-li:my-0 prose-ul:my-0.5 prose-ol:my-0.5 prose-code:text-xs prose-code:bg-background/80 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground prose-pre:bg-background/80 prose-pre:rounded prose-pre:p-2 prose-pre:my-1 prose-strong:text-foreground max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
          </div>
        </div>
      )}

      {alreadyAnswered && (
        <div className="border-t border-border/40 px-3 py-2">
          <p className="text-xs font-medium text-primary">→ {output}</p>
        </div>
      )}

      {onRespond && !submitted && (
        <div className="space-y-2 border-t border-border/40 px-3 py-2.5">
          <div className="flex gap-2">
            <button
              onClick={handleAccept}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('tools.acceptPlan')}
            </button>
            <button
              onClick={handleReject}
              className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            >
              <XCircle className="h-3.5 w-3.5" />
              {t('thread.rejectPlan')}
            </button>
          </div>

          <div className="flex gap-2">
            <Input
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
              className="h-auto flex-1 py-1.5"
            />
            <button
              onClick={handleSubmitInput}
              disabled={!input.trim()}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                input.trim()
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground cursor-not-allowed',
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
