import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { buildPath } from '@/lib/url';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useThreadId, useThreadProjectId, useThreadSelector } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

interface ProjectHeaderLeftContentProps {
  leading?: ReactNode;
}

export function ProjectHeaderLeftContent({ leading }: ProjectHeaderLeftContentProps) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const activeThreadId = useThreadId();
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadTitle = useThreadSelector((t) => t?.title);
  const activeThreadParentId = useThreadSelector((t) => t?.parentThreadId);
  const activeThreadTemplateId = useThreadSelector((t) => t?.agentTemplateId);
  const activeTemplate = useAgentTemplateStore((s) =>
    activeThreadTemplateId ? s.templates.find((t) => t.id === activeThreadTemplateId) : undefined,
  );
  const renameThread = useThreadStore((s) => s.renameThread);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const kanbanContext = useUIStore((s) => s.kanbanContext);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const startEditingTitle = useCallback(() => {
    if (!activeThreadId) return;
    setTitleDraft(activeThreadTitle ?? '');
    setIsEditingTitle(true);
  }, [activeThreadId, activeThreadTitle]);

  const commitTitleEdit = useCallback(() => {
    if (!activeThreadId || !activeThreadProjectId) {
      setIsEditingTitle(false);
      return;
    }
    const next = titleDraft.trim();
    if (next && next !== (activeThreadTitle ?? '').trim()) {
      renameThread(activeThreadId, activeThreadProjectId, next);
      toast.success(t('toast.threadRenamed', { title: next }));
    }
    setIsEditingTitle(false);
  }, [activeThreadId, activeThreadProjectId, activeThreadTitle, renameThread, t, titleDraft]);

  const cancelTitleEdit = useCallback(() => {
    setIsEditingTitle(false);
  }, []);

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditingTitle]);

  useEffect(() => {
    setIsEditingTitle(false);
  }, [activeThreadId]);

  const handleBackToKanban = useCallback(() => {
    if (!kanbanContext) return;

    const targetProjectId = kanbanContext.projectId || '__all__';
    const basePath = kanbanContext.viewMode === 'list' ? '/list' : '/kanban';

    // Close the review pane when returning to the board/list
    setReviewPaneOpen(false);

    // Navigate back to the originating view (list or kanban).
    // kanbanContext is cleared by useRouteSync when it detects the route,
    // ensuring both allThreadsProjectId and kanbanContext update in the same render.
    const params = new URLSearchParams();
    if (targetProjectId !== '__all__') params.set('project', targetProjectId);
    if (kanbanContext.search) params.set('search', kanbanContext.search);
    if (kanbanContext.caseSensitive) params.set('cs', '1');
    if (kanbanContext.threadId) params.set('highlight', kanbanContext.threadId);
    const qs = params.toString();
    navigate(buildPath(qs ? `${basePath}?${qs}` : basePath));
  }, [kanbanContext, navigate, setReviewPaneOpen]);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {leading}
      {kanbanContext && activeThreadId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              data-testid="header-back-kanban"
              variant="ghost"
              size="icon-sm"
              onClick={handleBackToKanban}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <ArrowLeft className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {kanbanContext.viewMode === 'list'
              ? t('allThreads.backToList', 'Back to list')
              : t('kanban.backToBoard', 'Back to Kanban')}
          </TooltipContent>
        </Tooltip>
      )}
      {!kanbanContext && activeThreadParentId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              data-testid="header-back-parent"
              variant="ghost"
              size="icon-sm"
              onClick={() =>
                navigate(
                  buildPath(`/projects/${activeThreadProjectId}/threads/${activeThreadParentId}`),
                )
              }
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <ArrowLeft className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('thread.backToParent', 'Back to parent thread')}</TooltipContent>
        </Tooltip>
      )}
      <Breadcrumb className="min-w-0">
        <BreadcrumbList>
          {activeThreadId && (
            <BreadcrumbItem className="max-w-[240px] min-w-0 sm:max-w-[360px] md:max-w-[520px]">
              {isEditingTitle ? (
                <span className="inline-grid max-w-full min-w-0 justify-start justify-items-start">
                  <span
                    aria-hidden
                    className="invisible col-start-1 row-start-1 overflow-hidden text-left text-sm font-medium whitespace-pre"
                  >
                    {titleDraft || ' '}
                  </span>
                  <input
                    ref={titleInputRef}
                    data-testid="header-thread-title-input"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={commitTitleEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitTitleEdit();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelTitleEdit();
                      }
                    }}
                    className="text-foreground col-start-1 row-start-1 w-full min-w-0 border-0 bg-transparent p-0 text-left text-sm font-medium ring-0 outline-hidden focus:ring-0 focus:outline-hidden"
                  />
                </span>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="button"
                      tabIndex={0}
                      data-testid="header-thread-title"
                      onClick={startEditingTitle}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          startEditingTitle();
                        }
                      }}
                      className="hover:text-accent-foreground block max-w-full min-w-0 cursor-text"
                    >
                      <ThreadTitle
                        as="span"
                        title={activeThreadTitle ?? ''}
                        density="title"
                        className="text-sm font-medium"
                        containerClassName="max-w-full"
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('thread.renameTitle', 'Click to rename')}</TooltipContent>
                </Tooltip>
              )}
            </BreadcrumbItem>
          )}
          {activeTemplate && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="shrink-0">
                <span
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={{
                    backgroundColor: activeTemplate.color
                      ? `${activeTemplate.color}22`
                      : 'hsl(var(--muted))',
                    color: activeTemplate.color ?? 'hsl(var(--muted-foreground))',
                  }}
                  data-testid="project-header-template-badge"
                >
                  {activeTemplate.color && (
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ backgroundColor: activeTemplate.color }}
                    />
                  )}
                  {activeTemplate.name}
                </span>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}
