import { MessageSquarePlus, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { listRowActionClassName } from '@/lib/list-row-styles';

interface PRActionsMenuProps {
  prNumber: number;
  branch?: string | null;
  onCreateThread: (branch: string) => void;
}

export function PRActionsMenu({ prNumber, branch, onCreateThread }: PRActionsMenuProps) {
  const { t } = useTranslation();
  const canCreateThread = !!branch;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          // oxlint-disable-next-line shadcn/require-static-classes -- listRowActionClassName is a static constant from list-row-styles
          className={listRowActionClassName}
          aria-label={t('review.pullRequests.actions', 'Pull request actions')}
          data-testid={`pr-actions-${prNumber}`}
        >
          <MoreHorizontal className="icon-sm" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="w-48">
        <DropdownMenuItem
          disabled={!canCreateThread}
          onSelect={() => {
            if (branch) onCreateThread(branch);
          }}
          data-testid={`pr-actions-new-thread-${prNumber}`}
        >
          <MessageSquarePlus className="icon-xs" />
          {t('review.pullRequests.createThreadFromBranch', 'New thread from branch')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
