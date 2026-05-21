import { Plus } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { buildPath } from '@/lib/url';
import { useUIStore } from '@/stores/ui-store';

/**
 * Sidebar entry point for scratch threads. The list itself lives in the
 * global search view (`/list?scratch=1`) — clicking the header opens that
 * filtered view; the "+" button still composes a new scratch thread.
 */
export function SidebarScratchSection() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const startNewScratchThread = useUIStore((s) => s.startNewScratchThread);

  const handleNewScratch = useCallback(() => {
    startNewScratchThread();
    navigate(buildPath('/scratch/new'));
  }, [startNewScratchThread, navigate]);

  const handleOpenScratchList = useCallback(() => {
    navigate(buildPath('/list?scratch=1'));
  }, [navigate]);

  return (
    <div className="flex shrink-0 flex-col" data-testid="sidebar-scratch-section">
      <div className="flex items-center justify-between px-4 pb-2 pt-2">
        <button
          type="button"
          onClick={handleOpenScratchList}
          data-testid="sidebar-scratch-open-list"
          className="text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('sidebar.scratchTitle', { defaultValue: 'Scratch' })}
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          onClick={handleNewScratch}
          data-testid="sidebar-scratch-new"
          aria-label={t('sidebar.scratchNew', { defaultValue: 'New scratch thread' })}
        >
          <Plus className="size-4" />
        </Button>
      </div>
    </div>
  );
}
