import { BookOpen, FileCode2, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface PreviewModeToggleProps {
  previewing: boolean;
  onToggle: () => void;
  loading?: boolean;
  disabled?: boolean;
  size?: 'icon-xs' | 'icon-sm';
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  testId?: string;
  sourceLabel?: string;
  className?: string;
}

export function PreviewModeToggle({
  previewing,
  onToggle,
  loading = false,
  disabled = false,
  size = 'icon-sm',
  tooltipSide = 'bottom',
  testId,
  sourceLabel,
  className,
}: PreviewModeToggleProps) {
  const { t } = useTranslation();
  const label = previewing
    ? (sourceLabel ?? t('tools.viewSource', 'View source'))
    : t('tools.preview', 'Preview');
  const iconClassName = size === 'icon-xs' ? 'icon-sm' : 'icon-base';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size={size}
          onClick={onToggle}
          disabled={disabled || loading}
          className={cn(
            'shrink-0 text-muted-foreground hover:text-foreground',
            previewing && 'bg-accent text-accent-foreground',
            className,
          )}
          data-testid={testId}
          aria-pressed={previewing}
          aria-label={label}
        >
          {loading ? (
            <Loader2 className={cn(iconClassName, 'animate-spin')} />
          ) : previewing ? (
            <FileCode2 className={iconClassName} />
          ) : (
            <BookOpen className={iconClassName} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}
