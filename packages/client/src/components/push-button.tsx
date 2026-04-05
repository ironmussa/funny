import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface PushButtonProps {
  onPush: () => void;
  pushInProgress: boolean;
  unpushedCommitCount: number;
  disabled?: boolean;
  testIdPrefix: string;
}

export function PushButton({
  onPush,
  pushInProgress,
  unpushedCommitCount,
  disabled,
  testIdPrefix,
}: PushButtonProps) {
  const { t } = useTranslation();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onPush}
          disabled={disabled ?? (pushInProgress || unpushedCommitCount === 0)}
          className="relative text-muted-foreground"
          data-testid={`${testIdPrefix}-push`}
        >
          <Upload className={cn('icon-base', pushInProgress && 'animate-pulse')} />
          {unpushedCommitCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-bold leading-none text-white">
              {unpushedCommitCount}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {unpushedCommitCount > 0
          ? t('review.readyToPush', {
              count: unpushedCommitCount,
              defaultValue: `${unpushedCommitCount} commit(s) ready to push`,
            })
          : t('review.pushToOrigin', 'Push to origin')}
      </TooltipContent>
    </Tooltip>
  );
}
