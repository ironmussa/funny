import { MessageSquarePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { listRowActionClassName } from '@/lib/list-row-styles';

interface PRCreateThreadButtonProps {
  prNumber: number;
  branch?: string | null;
  onCreateThread: (branch: string) => void;
}

/** Row action: start a thread on the pull request's head branch. Hidden when the PR has no branch. */
export function PRCreateThreadButton({
  prNumber,
  branch,
  onCreateThread,
}: PRCreateThreadButtonProps) {
  const { t } = useTranslation();
  if (!branch) return null;
  const label = t('review.pullRequests.createThreadFromBranch', 'New thread from branch');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          // oxlint-disable-next-line shadcn/require-static-classes -- listRowActionClassName is a static constant from list-row-styles
          className={listRowActionClassName}
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            onCreateThread(branch);
          }}
          data-testid={`pr-create-thread-${prNumber}`}
        >
          <MessageSquarePlus className="icon-sm" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
