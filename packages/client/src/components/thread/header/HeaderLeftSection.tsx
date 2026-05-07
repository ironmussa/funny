import { ArrowLeft, ExternalLink, FolderOpen } from 'lucide-react';
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { buildPath } from '@/lib/url';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadId, useThreadProjectId, useThreadSelector } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const LINEAR_URL_RE = /https?:\/\/linear\.app\/[^\s)]+/i;

function extractLinearUrl(text: string | undefined | null): string | null {
  if (!text) return null;
  const match = text.match(LINEAR_URL_RE);
  if (!match) return null;
  return match[0].replace(/[.,;:!?)\]]+$/, '');
}

function TitleEditor({
  activeThreadId,
  activeThreadProjectId,
  activeThreadTitle,
}: {
  activeThreadId: string | undefined;
  activeThreadProjectId: string | undefined;
  activeThreadTitle: string | undefined;
}) {
  const { t } = useTranslation();
  const renameThread = useThreadStore((s) => s.renameThread);
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

  const cancelTitleEdit = useCallback(() => setIsEditingTitle(false), []);

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditingTitle]);

  useEffect(() => {
    setIsEditingTitle(false);
  }, [activeThreadId]);

  if (isEditingTitle) {
    return (
      <span className="inline-grid min-w-0 max-w-full justify-start justify-items-start">
        <span
          aria-hidden
          className="invisible col-start-1 row-start-1 h-5 max-w-full overflow-hidden whitespace-nowrap text-left text-sm font-medium"
        >
          {titleDraft || ' '}
        </span>
        <Input
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
          className="col-start-1 row-start-1 h-5 w-full min-w-0 rounded-none border-0 bg-transparent p-0 text-left text-sm font-medium text-foreground shadow-none focus-visible:ring-0"
        />
      </span>
    );
  }
  return (
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
          className="block min-w-0 max-w-full cursor-text truncate text-sm font-medium hover:text-accent-foreground"
        >
          {activeThreadTitle}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xl break-words">{activeThreadTitle}</TooltipContent>
    </Tooltip>
  );
}

function BackButtons({
  activeThreadId,
  activeThreadProjectId,
  activeThreadParentId,
}: {
  activeThreadId: string | undefined;
  activeThreadProjectId: string | undefined;
  activeThreadParentId: string | null | undefined;
}) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const kanbanContext = useUIStore((s) => s.kanbanContext);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);

  const handleBackToKanban = useCallback(() => {
    if (!kanbanContext) return;
    const targetProjectId = kanbanContext.projectId || '__all__';
    const basePath = kanbanContext.viewMode === 'list' ? '/list' : '/kanban';
    setReviewPaneOpen(false);
    const params = new URLSearchParams();
    if (targetProjectId !== '__all__') params.set('project', targetProjectId);
    if (kanbanContext.search) params.set('search', kanbanContext.search);
    if (kanbanContext.threadId) params.set('highlight', kanbanContext.threadId);
    const qs = params.toString();
    navigate(buildPath(qs ? `${basePath}?${qs}` : basePath));
  }, [kanbanContext, navigate, setReviewPaneOpen]);

  if (kanbanContext && activeThreadId) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            data-testid="header-back-kanban"
            variant="ghost"
            size="icon-sm"
            onClick={handleBackToKanban}
            className="shrink-0 text-muted-foreground hover:text-foreground"
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
    );
  }
  if (!kanbanContext && activeThreadParentId) {
    return (
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
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('thread.backToParent', 'Back to parent thread')}</TooltipContent>
      </Tooltip>
    );
  }
  return null;
}

export function HeaderLeftSection() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const activeThreadId = useThreadId();
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadTitle = useThreadSelector((tt) => tt?.title);
  const activeThreadParentId = useThreadSelector((tt) => tt?.parentThreadId);
  const activeThreadTemplateId = useThreadSelector((tt) => tt?.agentTemplateId);
  const activeTemplate = useAgentTemplateStore((s) =>
    activeThreadTemplateId
      ? s.templates.find((tpl) => tpl.id === activeThreadTemplateId)
      : undefined,
  );
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const projectId = activeThreadProjectId ?? selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const linearUrl = extractLinearUrl(activeThreadTitle);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <BackButtons
        activeThreadId={activeThreadId}
        activeThreadProjectId={activeThreadProjectId}
        activeThreadParentId={activeThreadParentId}
      />
      <Breadcrumb className="min-w-0">
        <BreadcrumbList>
          {project && activeThreadId && (
            <BreadcrumbItem className="flex-shrink-0">
              <BreadcrumbLink asChild>
                <button
                  type="button"
                  data-testid={`header-project-name-${project.id}`}
                  onClick={() => {
                    startTransition(() => {
                      useProjectStore.getState().selectProject(project.id);
                      setReviewPaneOpen(false);
                      navigate(buildPath(`/projects/${project.id}`));
                    });
                    requestAnimationFrame(() => {
                      const el = document.querySelector(`[data-project-id="${project.id}"]`);
                      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    });
                  }}
                  className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm hover:text-foreground"
                >
                  <FolderOpen className="icon-sm text-muted-foreground" />
                  {project.name}
                </button>
              </BreadcrumbLink>
            </BreadcrumbItem>
          )}
          {project && activeThreadId && <BreadcrumbSeparator />}
          {activeThreadId && (
            <BreadcrumbItem className="min-w-0 max-w-[240px] sm:max-w-[360px] md:max-w-[520px]">
              <TitleEditor
                activeThreadId={activeThreadId}
                activeThreadProjectId={activeThreadProjectId}
                activeThreadTitle={activeThreadTitle}
              />
            </BreadcrumbItem>
          )}
          {activeTemplate && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="flex-shrink-0">
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
                      className="inline-block h-2 w-2 rounded-full"
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
      {linearUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={linearUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="header-linear-link"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <ExternalLink className="icon-base" />
            </a>
          </TooltipTrigger>
          <TooltipContent>{t('thread.openLinearTask', 'Open Linear task')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
