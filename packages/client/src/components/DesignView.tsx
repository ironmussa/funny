import type { Design } from '@funny/shared';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const ThreadView = lazy(() =>
  import('@/components/ThreadView').then((m) => ({ default: m.ThreadView })),
);

const log = createClientLogger('design-view');

export function DesignView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projectId = useUIStore((s) => s.designViewProjectId);
  const designId = useUIStore((s) => s.designViewDesignId);

  const selectThread = useThreadStore((s) => s.selectThread);

  const [design, setDesign] = useState<Design | null>(null);
  const [designLoading, setDesignLoading] = useState(true);
  const [designError, setDesignError] = useState<string | null>(null);

  useEffect(() => {
    if (!designId) return;
    let cancelled = false;
    setDesignLoading(true);
    setDesignError(null);
    (async () => {
      const res = await api.getDesign(designId);
      if (cancelled) return;
      if (res.isErr()) {
        log.error('getDesign failed', { designId, error: res.error });
        setDesignError(res.error.friendlyMessage ?? res.error.message ?? 'Failed to load design');
        setDesignLoading(false);
        return;
      }
      setDesign(res.value);
      setDesignLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [designId]);

  const goBack = useCallback(() => {
    void selectThread(null);
    if (projectId) {
      navigate(buildPath(`/projects/${projectId}/designs`));
    } else {
      navigate(buildPath('/'));
    }
  }, [navigate, projectId, selectThread]);

  const previewSrcDoc = useMemo(() => {
    const placeholder = t('designView.previewPlaceholder');
    return `<!doctype html><html><head><meta charset="utf-8"/><style>
      html,body{height:100%;margin:0;font:14px/1.5 system-ui,sans-serif;color:#666;background:#fafafa;}
      .wrap{display:flex;height:100%;align-items:center;justify-content:center;padding:24px;text-align:center;}
    </style></head><body><div class="wrap">${placeholder}</div></body></html>`;
  }, [t]);

  return (
    <div className="flex h-full w-full flex-col" data-testid="design-view">
      <header className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-background px-4">
        <Button
          data-testid="design-view-back"
          variant="ghost"
          size="sm"
          onClick={goBack}
          aria-label={t('common.back', { defaultValue: 'Back' })}
        >
          <ArrowLeft className="icon-base" />
        </Button>
        <Sparkles className="icon-base text-muted-foreground" />
        <h1 className="text-sm font-semibold">{design?.name ?? t('designView.loading')}</h1>
        {design && (
          <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t(`designView.types.${design.type}`, { defaultValue: design.type })}
          </span>
        )}
      </header>

      {designError ? (
        <div className="p-6">
          <p
            data-testid="design-view-error"
            className="rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-sm text-status-error"
          >
            {designError}
          </p>
        </div>
      ) : designLoading ? (
        <div className="space-y-3 p-6">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Column 1 — chat for the selected thread, or the existing new-thread prompt UI */}
          <div
            className="flex min-w-0 flex-1 flex-col border-r border-border"
            data-testid="design-thread-pane"
          >
            <Suspense
              fallback={
                <div className="p-6">
                  <Skeleton className="h-64 w-full" />
                </div>
              }
            >
              <ThreadView />
            </Suspense>
          </div>

          {/* Column 2 — design preview iframe */}
          <div
            className="flex w-[40%] min-w-[320px] flex-shrink-0 flex-col bg-background"
            data-testid="design-preview-pane"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('designView.previewTitle')}
              </span>
            </div>
            <iframe
              data-testid="design-preview-iframe"
              title={design?.name ?? 'design preview'}
              srcDoc={previewSrcDoc}
              className="flex-1 border-0 bg-white"
              sandbox="allow-scripts"
            />
          </div>
        </div>
      )}
    </div>
  );
}
