import type { Thread } from '@funny/shared';
import { FolderOpenDot, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { openThreadTerminal } from '@/lib/open-terminal-tab';
import { toastError } from '@/lib/toast-error';

/** "Open directory" and "Open terminal" items of a thread's menu (sidebar row, kanban card). */
export function ThreadOpenMenuItems({ thread }: { thread: Thread }) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem
        onClick={async (e) => {
          e.stopPropagation();
          const result = await api.openDirectory({ threadId: thread.id });
          if (result.isErr()) toastError(result.error);
        }}
      >
        <FolderOpenDot className="icon-sm" />
        {t('sidebar.openDirectory')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={(e) => {
          e.stopPropagation();
          openThreadTerminal({ thread });
        }}
      >
        <Terminal className="icon-sm" />
        {t('sidebar.openTerminal')}
      </DropdownMenuItem>
    </>
  );
}
