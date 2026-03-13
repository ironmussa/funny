import { Check, Copy, FileCode2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Button } from '@/components/ui/button';

export function PlanCard({
  parsed,
  output: _output,
  hideLabel,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const plan = parsed.plan as string | undefined;

  const handleCopy = async () => {
    if (!plan) return;
    await navigator.clipboard.writeText(plan);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!plan) return null;

  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border text-xs">
      {/* Header */}
      {!hideLabel && (
        <div className="flex items-center justify-between px-3 py-1.5 text-xs">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            <span className="font-medium text-foreground">{t('tools.plan')}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={handleCopy}
            data-testid="plan-copy-button"
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground" />
            )}
          </Button>
        </div>
      )}

      {/* Plan content */}
      <div className="max-h-[50vh] overflow-y-auto border-t border-border/40 px-4 py-3">
        <div className="prose prose-xs prose-invert prose-headings:text-foreground prose-headings:font-semibold prose-h1:text-xs prose-h1:mb-1.5 prose-h1:mt-0 prose-h2:text-xs prose-h2:mb-1 prose-h2:mt-2.5 prose-h3:text-sm prose-h3:mb-1 prose-h3:mt-2 prose-p:text-xs prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:my-0.5 prose-li:text-sm prose-li:text-muted-foreground prose-li:leading-relaxed prose-li:my-0 prose-ul:my-0.5 prose-ol:my-0.5 prose-code:text-xs prose-code:bg-background/80 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground prose-pre:bg-background/80 prose-pre:rounded prose-pre:p-2 prose-pre:my-1 prose-strong:text-foreground max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
