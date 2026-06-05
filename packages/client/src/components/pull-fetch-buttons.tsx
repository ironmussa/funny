import { CloudDownload, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface PullFetchButtonsProps {
  onPull: () => void;
  onFetch: () => void;
  pullInProgress: boolean;
  fetchInProgress: boolean;
  unpulledCommitCount: number;
  testIdPrefix: string;
}

export function PullFetchButtons({
  onPull,
  onFetch,
  pullInProgress,
  fetchInProgress,
  unpulledCommitCount,
  testIdPrefix,
}: PullFetchButtonsProps) {
  const { t } = useTranslation();

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onPull}
            disabled={pullInProgress}
            className="text-muted-foreground relative"
            data-testid={`${testIdPrefix}-pull`}
          >
            <Download className={cn('icon-base', pullInProgress && 'animate-pulse')} />
            {unpulledCommitCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] leading-none font-bold text-white">
                {unpulledCommitCount}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {unpulledCommitCount > 0
            ? t('review.readyToPull', {
                count: unpulledCommitCount,
                defaultValue: `${unpulledCommitCount} commit(s) to pull`,
              })
            : t('review.pull', 'Pull')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onFetch}
            disabled={fetchInProgress}
            className="text-muted-foreground"
            data-testid={`${testIdPrefix}-fetch-origin`}
          >
            <CloudDownload className={cn('icon-base', fetchInProgress && 'animate-pulse')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t('review.fetchOrigin', 'Fetch from origin')}</TooltipContent>
      </Tooltip>
    </>
  );
}
