import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { Button } from './ui/button';
import { CountBadge } from './ui/count-badge';
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
          className="text-muted-foreground relative"
          data-testid={`${testIdPrefix}-push`}
        >
          <Upload className={cn('icon-base', pushInProgress && 'animate-pulse')} />
          {unpushedCommitCount > 0 && <CountBadge count={unpushedCommitCount} />}
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
