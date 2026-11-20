import { ExternalLink, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The bar at the top of a review-pane tab (History, PRs, Actions, Issues):
 * refresh first, then the tab's filters, then a spacer and the trailing
 * actions (counts, "open on GitHub").
 */
export function TabToolbar({
  children,
  wrap = false,
  'data-testid': testId,
}: {
  children: ReactNode;
  /** Wrap onto a second line when narrow (History); otherwise scroll sideways. */
  wrap?: boolean;
  'data-testid'?: string;
}) {
  return (
    <div
      className={cn(
        'border-sidebar-border bg-background flex min-h-9 items-center gap-1 border-b px-2 py-1 text-xs',
        wrap ? 'flex-wrap' : 'overflow-x-auto',
      )}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** Pushes the following toolbar items to the right edge. */
export function TabToolbarSpacer() {
  return <div className="min-w-0 flex-1" />;
}

export function TabToolbarRefresh({
  loading,
  onRefresh,
  'data-testid': testId,
}: {
  loading: boolean;
  onRefresh: () => void;
  'data-testid': string;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRefresh}
          disabled={loading}
          aria-label={t('common.refresh', 'Refresh')}
          className="text-muted-foreground shrink-0"
          data-testid={testId}
        >
          <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
    </Tooltip>
  );
}

export function TabToolbarExternalLink({
  href,
  label,
  'data-testid': testId,
}: {
  href: string;
  label: string;
  'data-testid': string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          asChild
          className="text-muted-foreground shrink-0"
          data-testid={testId}
        >
          <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
            <ExternalLink className="icon-base" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
