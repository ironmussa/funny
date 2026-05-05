import type { GitStatusInfo, Thread } from '@funny/shared';
import { Archive } from 'lucide-react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { KanbanView } from '@/components/KanbanView';
import { ThreadPowerline } from '@/components/ThreadPowerline';
import { VirtualThreadList } from '@/components/VirtualThreadList';
import { buildPath } from '@/lib/url';
import { branchKey as computeBranchKey, useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

interface Props {
  viewMode: 'list' | 'board';
  threads: Thread[];
  search: string;
  contentMatches: Map<string, string>;
  highlightThreadId?: string;
  projectFilter: string | null;
  projectInfoById: Record<string, { name: string; color?: string }>;
  hasMoreServerThreads: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  searchKeyDownRef: RefObject<((e: React.KeyboardEvent) => void) | null>;
}

/**
 * The thread-content area of AllThreadsView: either a KanbanView (board
 * mode) or a VirtualThreadList (list mode). Extracted so the parent fits
 * inside the 150-line function lint limit and so KanbanView /
 * VirtualThreadList / ThreadPowerline / Archive icon move out of the parent
 * import graph.
 */
export function AllThreadsContent({
  viewMode,
  threads,
  search,
  contentMatches,
  highlightThreadId,
  projectFilter,
  projectInfoById,
  hasMoreServerThreads,
  loadingMore,
  onLoadMore,
  searchKeyDownRef,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const statusByBranch = useGitStatusStore((s) => s.statusByBranch);

  if (viewMode === 'board') {
    return (
      <div className="min-h-0 flex-1">
        <KanbanView
          threads={threads}
          projectId={projectFilter || undefined}
          search={search}
          contentSnippets={contentMatches}
          highlightThreadId={highlightThreadId}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
      <VirtualThreadList
        threads={threads}
        search={search}
        contentSnippets={contentMatches}
        emptyMessage={t('allThreads.noThreads')}
        searchEmptyMessage={t('allThreads.noMatch')}
        hideBranch
        hasMore={hasMoreServerThreads}
        loadingMore={loadingMore}
        onEndReached={onLoadMore}
        onSearchKeyDownRef={searchKeyDownRef}
        onThreadClick={(thread) => {
          const projectStore = useProjectStore.getState();
          if (!projectStore.expandedProjects.has(thread.projectId)) {
            projectStore.toggleProject(thread.projectId);
          }
          useUIStore.getState().setKanbanContext({
            projectId: projectFilter || undefined,
            search,
            threadId: thread.id,
            viewMode: 'list',
          });
          navigate(buildPath(`/projects/${thread.projectId}/threads/${thread.id}`));

          const scrollToThread = () => {
            const el = document.querySelector(
              `[data-project-id="${thread.projectId}"] [data-testid="thread-item-${thread.id}"]`,
            );
            if (el) {
              el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
              return true;
            }
            return false;
          };
          requestAnimationFrame(() => {
            if (scrollToThread()) return;
            setTimeout(scrollToThread, 300);
          });
        }}
        renderExtraBadges={(thread) => {
          const gs: GitStatusInfo | undefined = statusByBranch[computeBranchKey(thread)];
          const pInfo = projectInfoById[thread.projectId];
          return (
            <>
              <ThreadPowerline
                thread={thread}
                projectName={!projectFilter ? pInfo?.name : undefined}
                projectColor={pInfo?.color}
                gitStatus={gs}
                diffStatsSize="xxs"
                data-testid={`list-thread-powerline-${thread.id}`}
              />
              {!!thread.archived && (
                <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-px text-[10px] font-medium leading-tight text-status-warning/80">
                  <Archive className="icon-2xs" />
                  {t('allThreads.archived')}
                </span>
              )}
            </>
          );
        }}
      />
    </div>
  );
}
