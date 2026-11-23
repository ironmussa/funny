import { Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';

/** The menu item that stops a running thread's agent. */
export function StopThreadMenuItem({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem
      variant="destructive"
      onClick={async (e) => {
        e.stopPropagation();
        const result = await api.stopThread(threadId);
        if (result.isErr()) console.error('Failed to stop thread:', result.error);
      }}
    >
      <Square className="icon-sm" />
      {t('common.stop')}
    </DropdownMenuItem>
  );
}
