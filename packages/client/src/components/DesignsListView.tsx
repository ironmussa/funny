import type { Design } from '@funny/shared';
import { ArrowLeft, Plus, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CreateDesignDialog } from '@/components/CreateDesignDialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('designs-list-view');

export function DesignsListView() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const projectId = useUIStore((s) => s.designsListProjectId);
  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId) ?? null);

  const [designs, setDesigns] = useState<Design[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await api.listDesigns(projectId);
      if (cancelled) return;
      if (res.isErr()) {
        log.error('listDesigns failed', { projectId, error: res.error });
        setError(res.error.friendlyMessage ?? res.error.message ?? 'Failed to load designs');
        setLoading(false);
        return;
      }
      setDesigns(res.value);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  const goBack = () => {
    if (projectId) {
      navigate(buildPath(`/projects/${projectId}`));
    } else {
      navigate(buildPath('/'));
    }
  };

  const openDesign = (designId: string) => {
    if (!projectId) return;
    navigate(buildPath(`/projects/${projectId}/designs/${designId}`));
  };

  if (!projectId) return null;

  const projectName = project?.name ?? '';

  return (
    <div className="flex size-full flex-col" data-testid="designs-list-view">
      <header className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-background px-4">
        <Button
          data-testid="designs-list-back"
          variant="ghost"
          size="sm"
          onClick={goBack}
          aria-label={t('designsList.back', { defaultValue: 'Back' })}
        >
          <ArrowLeft className="icon-base" />
        </Button>
        <Sparkles className="icon-base text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">
            {t('designsList.title', { defaultValue: 'Designs' })}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {designs.length === 0
              ? t('designsList.subtitleZero', {
                  name: projectName,
                  defaultValue: `${projectName} · No designs yet`,
                })
              : t('designsList.subtitle', {
                  name: projectName,
                  count: designs.length,
                  defaultValue: `${projectName} · ${designs.length} designs`,
                })}
          </p>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-6">
          {loading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[4/3] w-full" />
              ))}
            </div>
          ) : error ? (
            <p
              data-testid="designs-list-error"
              className="rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-sm text-status-error"
            >
              {error}
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
              <NewDesignCard
                onClick={() => setCreateOpen(true)}
                label={t('designsList.newDesign', { defaultValue: 'New design' })}
                hint={t('designsList.newDesignHint', {
                  defaultValue: 'Start a prototype or slide deck',
                })}
              />
              {designs.map((d) => (
                <DesignCard
                  key={d.id}
                  design={d}
                  typeLabel={t(`designView.types.${d.type}`, { defaultValue: d.type })}
                  onClick={() => openDesign(d.id)}
                />
              ))}
              {designs.length === 0 && (
                <p
                  data-testid="designs-list-empty"
                  className="col-span-full text-center text-sm text-muted-foreground"
                >
                  {t('designsList.empty', {
                    defaultValue: 'No designs yet. Create your first one.',
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {project && (
        <CreateDesignDialog
          open={createOpen}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) setReloadKey((k) => k + 1);
          }}
          projectId={project.id}
          projectName={project.name}
        />
      )}
    </div>
  );
}

interface NewDesignCardProps {
  onClick: () => void;
  label: string;
  hint: string;
}

function NewDesignCard({ onClick, label, hint }: NewDesignCardProps) {
  return (
    <button
      type="button"
      data-testid="designs-list-new-card"
      onClick={onClick}
      className={cn(
        'group flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-card transition-colors',
        'hover:border-primary hover:bg-accent/30',
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary group-hover:bg-primary/20">
        <Plus className="icon-base" />
      </div>
      <span className="text-sm font-medium">{label}</span>
      <span className="px-3 text-center text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}

interface DesignCardProps {
  design: Design;
  typeLabel: string;
  onClick: () => void;
}

function DesignCard({ design, typeLabel, onClick }: DesignCardProps) {
  return (
    <button
      type="button"
      data-testid={`designs-list-card-${design.id}`}
      onClick={onClick}
      className={cn(
        'group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors',
        'hover:border-primary hover:bg-accent/30',
      )}
    >
      <div className="flex aspect-[4/3] w-full items-center justify-center bg-muted/40">
        <Sparkles className="size-8 text-muted-foreground/60" />
      </div>
      <div className="flex flex-col gap-1 border-t border-border px-3 py-2">
        <span className="truncate text-sm font-medium">{design.name}</span>
        <span className="text-xs text-muted-foreground">{typeLabel}</span>
      </div>
    </button>
  );
}
