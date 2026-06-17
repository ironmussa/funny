import { ListTree, Plus, Sparkles } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ThreadPickerDialog } from '@/components/live-columns/ThreadPickerDialog';
import { NewThreadInput } from '@/components/thread/NewThreadInput';
import { Button } from '@/components/ui/button';

interface Props {
  cellIndex: number;
  onCreated: (threadId: string) => void;
  /** Load an existing thread into this cell. */
  onLoadExisting: (threadId: string) => void;
  initialProjectId?: string;
  onConsumePreset?: () => void;
  onRequestPickProject: () => void;
  /** Thread ids already placed in the grid (for the "in grid" hint). */
  gridThreadIds?: Set<string>;
}

export const EmptyGridCell = memo(function EmptyGridCell({
  cellIndex,
  onCreated,
  onLoadExisting,
  initialProjectId,
  onConsumePreset,
  onRequestPickProject,
  gridThreadIds,
}: Props) {
  const { t } = useTranslation();
  const [selectedProject, setSelectedProject] = useState<string | null>(initialProjectId ?? null);
  const [scratchMode, setScratchMode] = useState(false);
  const [threadPickerOpen, setThreadPickerOpen] = useState(false);

  // Sync from preset coming in via props (header "+" or Ctrl+N landed a project
  // in this cell). Mount-time presets and post-mount presets are handled the
  // same way: adopt the project, then tell the parent to clear the entry so
  // the cell isn't repeatedly resurrected.
  useEffect(() => {
    if (initialProjectId && initialProjectId !== selectedProject) {
      setSelectedProject(initialProjectId);
      setScratchMode(false);
      onConsumePreset?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProjectId]);

  const handleCancel = useCallback(() => {
    setSelectedProject(null);
    setScratchMode(false);
  }, []);

  if (scratchMode) {
    return (
      <div
        className="border-border/60 bg-muted/10 flex h-full w-full flex-col rounded-sm border-2 border-dashed"
        data-testid={`grid-empty-cell-${cellIndex}`}
      >
        <NewThreadInput isScratchOverride onCreated={onCreated} onCancel={handleCancel} />
      </div>
    );
  }

  if (!selectedProject) {
    return (
      <div
        className="border-border/60 bg-muted/10 hover:border-primary/50 hover:bg-muted/30 flex h-full w-full items-center justify-center gap-2 rounded-sm border-2 border-dashed p-4 transition-colors"
        data-testid={`grid-empty-cell-${cellIndex}`}
      >
        <Button
          variant="default"
          size="sm"
          className="h-7"
          data-testid={`grid-empty-new-${cellIndex}`}
          onClick={onRequestPickProject}
        >
          <Plus className="icon-sm" />
          {t('live.newThread', 'New thread')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          data-testid={`grid-empty-new-scratch-${cellIndex}`}
          onClick={() => setScratchMode(true)}
        >
          <Sparkles className="icon-sm" />
          {t('live.newScratch', 'New scratch')}
        </Button>
      </div>
    );
  }

  return (
    <div
      className="border-border/60 bg-muted/10 flex h-full w-full flex-col rounded-sm border-2 border-dashed"
      data-testid={`grid-empty-cell-${cellIndex}`}
    >
      <NewThreadInput
        projectIdOverride={selectedProject}
        onCreated={onCreated}
        onCancel={handleCancel}
      />
      <div className="border-border/40 flex shrink-0 items-center justify-center border-t px-3 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-7"
          data-testid={`grid-load-existing-${cellIndex}`}
          onClick={() => setThreadPickerOpen(true)}
        >
          <ListTree className="icon-sm" />
          {t('live.loadExisting', 'Load existing thread')}
        </Button>
      </div>
      <ThreadPickerDialog
        open={threadPickerOpen}
        onOpenChange={setThreadPickerOpen}
        projectId={selectedProject}
        gridThreadIds={gridThreadIds}
        onSelect={onLoadExisting}
      />
    </div>
  );
});
