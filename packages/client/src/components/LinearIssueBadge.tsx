import { SiLinear } from '@icons-pack/react-simple-icons';
import { useTranslation } from 'react-i18next';

import { Chip, type ChipSize, type ChipVariant } from '@/components/ui/chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface LinearIssueBadgeProps {
  issueKey: string;
  issueUrl?: string;
  size?: 'sm' | 'xs' | 'compact' | 'xxs';
  variant?: ChipVariant;
  showExternalIcon?: boolean;
  className?: string;
  'data-testid'?: string;
}

const SIZE_MAP: Record<NonNullable<LinearIssueBadgeProps['size']>, ChipSize> = {
  sm: 'sm',
  xs: 'sm',
  compact: 'xxs',
  xxs: 'xxs',
};

export function LinearIssueBadge({
  issueKey,
  issueUrl,
  size = 'xs',
  variant = 'default',
  showExternalIcon = !!issueUrl,
  className,
  ...props
}: LinearIssueBadgeProps) {
  const { t } = useTranslation();
  const label = t('thread.linearIssue', {
    issue: issueKey,
    defaultValue: `Linear ${issueKey}`,
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Chip
          icon={SiLinear}
          label={issueKey}
          href={issueUrl}
          ariaLabel={label}
          showExternalIcon={showExternalIcon}
          size={SIZE_MAP[size]}
          variant={variant}
          className={className}
          data-testid={props['data-testid']}
        />
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
