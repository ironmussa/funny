import { Plus } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NewThreadInput } from '@/components/thread/NewThreadInput';
import { Button } from '@/components/ui/button';

interface Props {
  cellIndex: number;
  onCreated: (threadId: string) => void;
  initialProjectId?: string;
  onConsumePreset?: () => void;
  onRequestPickProject: () => void;
}

export const EmptyGridCell = memo(function EmptyGridCell({
  cellIndex,
  onCreated,
  initialProjectId,
  onConsumePreset,
  onRequestPickProject,
}: Props) {
  const { t } = useTranslation();
  const [selectedProject, setSelectedProject] = useState<string | null>(initialProjectId ?? null);

  // Sync from preset coming in via props (header "+" or Ctrl+N landed a project
  // in this cell). Mount-time presets and post-mount presets are handled the
  // same way: adopt the project, then tell the parent to clear the entry so
  // the cell isn't repeatedly resurrected.
  useEffect(() => {
    if (initialProjectId && initialProjectId !== selectedProject) {
      setSelectedProject(initialProjectId);
      onConsumePreset?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProjectId]);

  const handleCancel = useCallback(() => {
    setSelectedProject(null);
  }, []);

  if (!selectedProject) {
    return (
      <div
        className="flex h-full w-full items-center justify-center rounded-sm border-2 border-dashed border-border/60 bg-muted/10 p-4 transition-colors hover:border-primary/50 hover:bg-muted/30"
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
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col rounded-sm border-2 border-dashed border-border/60 bg-muted/10"
      data-testid={`grid-empty-cell-${cellIndex}`}
    >
      <NewThreadInput
        projectIdOverride={selectedProject}
        onCreated={onCreated}
        onCancel={handleCancel}
      />
    </div>
  );
});
