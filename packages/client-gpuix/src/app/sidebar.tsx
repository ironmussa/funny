/** Project and thread sidebar of the native app. */

import { IconButton } from '@funny/gpuix-ui/button';
import { Icon } from '@funny/gpuix-ui/icon';
import {
  GitChangesIndicator,
  GitChangesSummary,
  Powerline,
  PowerlineSegment,
} from '@funny/gpuix-ui/powerline';
import {
  ProjectGroup,
  SidebarBody,
  SidebarDisclosureSection,
  SidebarFooter,
  SidebarProfile,
  SidebarSection,
  SidebarShell,
  type ThreadItemStatus,
  ThreadListItem,
} from '@funny/gpuix-ui/sidebar';
import { scrollbarStyle } from '@funny/gpuix-ui/theme';
import { ScrollableVirtualList } from '@funny/gpuix-ui/virtual-list-scrollbar';
import { clampWindowStart, windowStartForVisibleRange } from '@funny/gpuix-ui/virtual-range';
import type { GitStatusInfo, Thread } from '@funny/shared';
import type { EventPayload } from '@gpuix/react';
import { memo, type ReactElement, useCallback, useMemo, useState } from 'react';

import type { NativeApplicationServices } from '../application';
import { nativeGitStatusForThread } from '../git-status-state';
import {
  formatSidebarRelativeTime,
  recentSidebarThreads,
  sidebarThreadStatus,
  sidebarThreadSummary,
  visibleProjectThreads,
} from '../sidebar-model';
import { selectSelectedThreadId, useNativeColors, useStore, useStoreValue } from './hooks';

const SIDEBAR_RETAINED_WINDOW_SIZE = 48;
const SIDEBAR_WINDOW_BUFFER = 12;

function ThreadLink({
  thread,
  selected,
  onSelect,
  projectName,
  projectColor,
  gitStatus,
}: {
  thread: Thread;
  selected: boolean;
  onSelect(): void;
  projectName?: string;
  projectColor?: string;
  gitStatus?: GitStatusInfo;
}) {
  const colors = useNativeColors();
  const status: ThreadItemStatus = sidebarThreadStatus(thread.status);
  const summary = sidebarThreadSummary(thread);
  return (
    <ThreadListItem
      testId={`thread-${thread.id}`}
      selected={selected}
      onSelect={onSelect}
      title={thread.title || 'Untitled thread'}
      status={status}
      time={formatSidebarRelativeTime(thread.updatedAt)}
      marker={thread.pinned ? <Icon name="pin" size={12} color={colors.muted} /> : undefined}
      metadata={
        <>
          <Powerline>
            {projectName ? (
              <PowerlineSegment
                color={projectColor ?? colors.raised}
                icon={<Icon name="project" size={10} color={colors.text} />}
              >
                {projectName}
              </PowerlineSegment>
            ) : null}
            {thread.mode === 'worktree' &&
            thread.baseBranch &&
            thread.baseBranch !== thread.branch ? (
              <PowerlineSegment icon={<Icon name="branch" size={10} color={colors.muted} />}>
                {thread.baseBranch}
              </PowerlineSegment>
            ) : null}
            {thread.branch ? (
              <PowerlineSegment icon={<Icon name="branch" size={10} color={colors.muted} />}>
                {thread.branch}
              </PowerlineSegment>
            ) : null}
            <GitChangesIndicator
              files={gitStatus?.dirtyFileCount ?? null}
              added={gitStatus?.linesAdded ?? null}
              deleted={gitStatus?.linesDeleted ?? null}
            />
          </Powerline>
          {summary ? <text style={{ color: colors.muted, lineClamp: 1 }}>{summary}</text> : null}
        </>
      }
    />
  );
}

export const Sidebar = memo(function Sidebar({
  application,
}: {
  application: NativeApplicationServices;
}) {
  const colors = useNativeColors();
  const navigation = useStore(application.navigationState);
  const selectedThreadId = useStoreValue(application.workspaceState, selectSelectedThreadId);
  const auth = useStore(application.authState);
  const gitStatuses = useStore(application.gitStatusState);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [windowStart, setWindowStart] = useState(0);
  const rows = useMemo<ReactElement[]>(() => {
    const next: ReactElement[] = [];
    const toggleGroup = (key: string, rowIndex: number) => {
      setWindowStart((current) => Math.min(current, rowIndex));
      setCollapsedGroups((current) => {
        const updated = new Set(current);
        if (updated.has(key)) updated.delete(key);
        else updated.add(key);
        return updated;
      });
    };
    const pushLinks = (key: string, ids: string[], projectName?: string, projectColor?: string) => {
      for (const id of ids) {
        const thread = navigation.threadsById[id];
        if (!thread) continue;
        next.push(
          <ThreadLink
            key={`${key}:thread:${id}`}
            thread={thread}
            selected={selectedThreadId === id}
            onSelect={() => void application.data.selectThread(id)}
            projectName={projectName}
            projectColor={projectColor}
            gitStatus={nativeGitStatusForThread(gitStatuses, thread)}
          />,
        );
      }
    };
    const allThreads = Object.values(navigation.threadsById);
    const activity = recentSidebarThreads(allThreads);
    if (activity.length > 0) {
      const key = 'activity';
      const rowIndex = next.length;
      const expanded = !collapsedGroups.has(key);
      next.push(
        <SidebarDisclosureSection
          key={key}
          title="ACTIVITY"
          expanded={expanded}
          onToggle={() => toggleGroup(key, rowIndex)}
        />,
      );
      if (expanded) {
        for (const thread of activity) {
          pushLinks(
            key,
            [thread.id],
            thread.projectId ? navigation.projectsById[thread.projectId]?.name : 'Quick chat',
            thread.projectId ? navigation.projectsById[thread.projectId]?.color : undefined,
          );
        }
        if (allThreads.length > activity.length) {
          next.push(
            <text
              key="activity:view-all"
              style={{ color: colors.muted, fontSize: 11, paddingLeft: 20 }}
            >
              View all
            </text>,
          );
        }
      }
    }

    if (navigation.projectIds.length > 0) {
      next.push(<SidebarSection key="projects" title="PROJECTS" />);
    }
    for (const projectId of navigation.projectIds) {
      const key = `project:${projectId}`;
      const rowIndex = next.length;
      const expanded = !collapsedGroups.has(key);
      const project = navigation.projectsById[projectId];
      const projectThreads = visibleProjectThreads(
        (navigation.threadIdsByProject[projectId] ?? []).flatMap((id) => {
          const thread = navigation.threadsById[id];
          return thread ? [thread] : [];
        }),
      );
      next.push(
        <ProjectGroup
          key={key}
          title={project?.name ?? 'Project'}
          expanded={expanded}
          onToggle={() => toggleGroup(key, rowIndex)}
        />,
      );
      if (!expanded) continue;
      pushLinks(
        key,
        projectThreads.map((thread) => thread.id),
      );
      if (
        (navigation.threadTotalByProject[projectId] ?? projectThreads.length) >
        projectThreads.length
      ) {
        next.push(
          <text
            key={`${key}:view-all`}
            style={{ color: colors.muted, fontSize: 11, paddingLeft: 20 }}
          >
            View all
          </text>,
        );
      }
    }

    if (navigation.sharedThreadIds.length > 0) {
      const key = 'shared';
      const rowIndex = next.length;
      const expanded = !collapsedGroups.has(key);
      next.push(
        <SidebarDisclosureSection
          key={key}
          title="SHARED WITH ME"
          expanded={expanded}
          onToggle={() => toggleGroup(key, rowIndex)}
        />,
      );
      if (expanded) pushLinks(key, navigation.sharedThreadIds);
    }
    if (navigation.scratchThreadIds.length > 0) {
      const key = 'scratch';
      const rowIndex = next.length;
      const expanded = !collapsedGroups.has(key);
      next.push(
        <ProjectGroup
          key={key}
          title="Quick Chats"
          icon={<Icon name="chat" size={14} color={colors.muted} />}
          expanded={expanded}
          onToggle={() => toggleGroup(key, rowIndex)}
        />,
      );
      if (expanded) pushLinks(key, navigation.scratchThreadIds);
    }
    return next;
  }, [application, collapsedGroups, colors, gitStatuses, navigation, selectedThreadId]);
  const effectiveWindowStart = clampWindowStart(
    windowStart,
    rows.length,
    SIDEBAR_RETAINED_WINDOW_SIZE,
  );
  const retainedRows = rows.slice(
    effectiveWindowStart,
    effectiveWindowStart + SIDEBAR_RETAINED_WINDOW_SIZE,
  );
  const updateRetainedWindow = useCallback(
    (event: EventPayload) => {
      const visibleStart = Math.max(0, Math.floor(event.startIndex ?? 0));
      const visibleEnd = Math.max(visibleStart + 1, Math.ceil(event.endIndex ?? visibleStart + 1));
      setWindowStart((current) =>
        windowStartForVisibleRange({
          currentStart: current,
          itemCount: rows.length,
          windowSize: SIDEBAR_RETAINED_WINDOW_SIZE,
          buffer: SIDEBAR_WINDOW_BUFFER,
          visibleStart,
          visibleEnd,
        }),
      );
    },
    [rows.length],
  );

  const selectedThread = selectedThreadId ? navigation.threadsById[selectedThreadId] : undefined;
  const selectedGitStatus = selectedThread
    ? nativeGitStatusForThread(gitStatuses, selectedThread)
    : undefined;

  return (
    <SidebarShell testId="native-sidebar" style={{ width: '100%', minWidth: 0 }}>
      <SidebarBody>
        {rows.length > 0 ? (
          <ScrollableVirtualList
            scrollbarTestId="native-sidebar-scrollbar"
            itemCount={rows.length}
            windowStart={effectiveWindowStart}
            estimatedItemHeight={56}
            overdraw={240}
            onVisibleRange={updateRetainedWindow}
            role="list"
            aria-label="Projects and threads"
            style={{
              flexGrow: 1,
              minHeight: 0,
              width: '100%',
              gap: 14,
              ...scrollbarStyle(colors),
            }}
          >
            {retainedRows}
          </ScrollableVirtualList>
        ) : (
          <text style={{ color: colors.muted, padding: 8 }}>
            No accessible projects or threads.
          </text>
        )}
      </SidebarBody>
      {selectedThreadId ? (
        <GitChangesSummary
          testId="navigation-diff-summary"
          label={selectedThread?.branch ?? 'Changes'}
          files={selectedGitStatus?.dirtyFileCount ?? null}
          added={selectedGitStatus?.linesAdded ?? null}
          deleted={selectedGitStatus?.linesDeleted ?? null}
        />
      ) : null}
      {auth.user ? (
        <SidebarFooter>
          <SidebarProfile
            testId="sidebar-profile"
            name={auth.user.displayName || auth.user.username}
            username={auth.user.username}
            action={
              <IconButton
                testId="sidebar-logout"
                label="Log out"
                icon={<Icon name="overflow" size={15} color={colors.muted} />}
                onPress={() => void application.logout()}
                style={{ width: 28, height: 28 }}
              />
            }
          />
        </SidebarFooter>
      ) : null}
    </SidebarShell>
  );
});
