import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The external link arrow beside a PR or issue chip: the chip opens funny's own
 * view, this arrow opens the item on GitHub. It takes the chip's text color
 * (`text-current`), so set the color on a parent or through `className`.
 */
export function GitHubExternalLink({
  url,
  iconClassName,
  className,
  'data-testid': testId,
}: {
  url: string;
  iconClassName?: string;
  className?: string;
  'data-testid'?: string;
}) {
  const { t } = useTranslation();
  const label = t('githubItemViewer.openOnGithub', 'Open on GitHub');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            'focus-visible:ring-ring inline-flex shrink-0 items-center rounded-sm text-current opacity-70 hover:opacity-100 focus-visible:ring-1 focus-visible:outline-none',
            className,
          )}
          aria-label={label}
          data-testid={testId}
        >
          <ArrowUpRight className={cn('icon-xs', iconClassName)} aria-hidden="true" />
        </a>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
