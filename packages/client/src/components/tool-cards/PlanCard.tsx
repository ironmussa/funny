import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileCode2, Check } from 'lucide-react';

export function PlanCard({ parsed, output, onRespond, hideLabel }: { parsed: Record<string, unknown>; output?: string; onRespond?: (answer: string) => void; hideLabel?: boolean }) {
  const { t } = useTranslation();
  const plan = parsed.plan as string | undefined;
  const [accepted, setAccepted] = useState(!!output);

  if (!plan) return null;

  const handleAccept = () => {
    if (accepted || !onRespond) return;
    onRespond('Plan accepted');
    setAccepted(true);
  };

  return (
    <div className="text-xs max-w-full overflow-hidden">
      {/* Header */}
      {!hideLabel && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
          <FileCode2 className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          <span className="font-medium text-foreground">{t('tools.plan')}</span>
        </div>
      )}

      {/* Plan content */}
      <div className="border-t border-border/40 px-4 py-3 max-h-[500px] overflow-y-auto">
        <div className="prose prose-xs prose-invert max-w-none
          prose-headings:text-foreground prose-headings:font-semibold
          prose-h1:text-xs prose-h1:mb-1.5 prose-h1:mt-0
          prose-h2:text-xs prose-h2:mb-1 prose-h2:mt-2.5
          prose-h3:text-sm prose-h3:mb-1 prose-h3:mt-2
          prose-p:text-xs prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:my-0.5
          prose-li:text-sm prose-li:text-muted-foreground prose-li:leading-relaxed prose-li:my-0
          prose-ul:my-0.5 prose-ol:my-0.5
          prose-code:text-xs prose-code:bg-background/80 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground
          prose-pre:bg-background/80 prose-pre:rounded prose-pre:p-2 prose-pre:my-1
          prose-strong:text-foreground
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {plan}
          </ReactMarkdown>
        </div>
      </div>

      {/* Accept button */}
      {onRespond && !accepted && (
        <div className="border-t border-border/40 px-3 py-2 flex justify-end">
          <button
            onClick={handleAccept}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-muted-foreground/20 text-foreground/80 hover:bg-muted-foreground/30 transition-colors"
          >
            <Check className="h-3 w-3" />
            {t('tools.acceptPlan')}
          </button>
        </div>
      )}
    </div>
  );
}
