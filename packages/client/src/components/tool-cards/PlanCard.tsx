import { Check, Copy, FileCode2 } from 'lucide-react';
import { Suspense, lazy, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { remarkPlugins } from '@/lib/markdown-components';

import { ToolContentArea } from './MobileContentPreview';

const LazyMarkdown = lazy(() =>
  import('react-markdown').then(({ default: ReactMarkdown }) => ({
    default: function PlanMarkdown({ content }: { content: string }) {
      return <ReactMarkdown remarkPlugins={remarkPlugins}>{content}</ReactMarkdown>;
    },
  })),
);

export function PlanCard({
  parsed,
  output: _output,
  hideLabel,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
  displayTime?: string | null;
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
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-xs">
      {/* Header */}
      {!hideLabel && (
        <div className="flex items-center justify-between px-3 py-1.5 text-xs">
          <div className="flex items-center gap-2">
            <FileCode2 className="icon-xs text-muted-foreground shrink-0" />
            <span className="text-foreground font-medium">{t('tools.plan')}</span>
            {displayTime && (
              <span className="text-muted-foreground/50 text-2xs tabular-nums">{displayTime}</span>
            )}
          </div>
          <TooltipIconButton
            size="icon"
            className="size-5"
            onClick={handleCopy}
            data-testid="plan-copy-button"
            tooltip={copied ? t('common.copied') : t('common.copy')}
          >
            {copied ? (
              <Check className="icon-xs text-status-success" />
            ) : (
              <Copy className="icon-xs text-muted-foreground" />
            )}
          </TooltipIconButton>
        </div>
      )}

      {/* Plan content */}
      <ToolContentArea viewportProps={{ className: 'max-h-[50vh] scroll-fade-none' }}>
        <div className="px-4 py-3">
          <div className="prose max-w-none">
            <Suspense
              fallback={
                <pre className="text-muted-foreground font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                  {plan}
                </pre>
              }
            >
              <LazyMarkdown content={plan} />
            </Suspense>
          </div>
        </div>
      </ToolContentArea>
    </div>
  );
}
