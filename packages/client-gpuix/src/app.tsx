import type { StoreApi, ThreadWorkspaceData } from '@funny/client-core';
import { Button, IconButton } from '@funny/gpuix-ui/button';
import {
  ComposerActions,
  ComposerContext,
  PromptComposer,
  PromptEditorSurface,
} from '@funny/gpuix-ui/composer';
import { AssistantMessage, ConversationRow, UserMessageCard } from '@funny/gpuix-ui/conversation';
import { DockLayout } from '@funny/gpuix-ui/dock-layout';
import { FileTree } from '@funny/gpuix-ui/file-tree';
import { Icon } from '@funny/gpuix-ui/icon';
import { eventValue, Input, Textarea } from '@funny/gpuix-ui/input';
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
  ThreadListItem,
  type ThreadItemStatus,
} from '@funny/gpuix-ui/sidebar';
import {
  PermissionCard as UiPermissionCard,
  StatusCard,
  ToolCallCard,
} from '@funny/gpuix-ui/status-card';
import { gpuixTheme, GpuixUiProvider, useGpuixUiTheme } from '@funny/gpuix-ui/theme';
import { ThreadHeader } from '@funny/gpuix-ui/thread-header';
import {
  clampWindowStart,
  maximumWindowStart,
  shiftedWindowStartForItems,
  windowStartForVisibleRange,
} from '@funny/gpuix-ui/virtual-range';
import type { GitStatusInfo, Thread, ToolCall } from '@funny/shared';
import { useWindowSize } from '@gpuix/react';
import type { EventPayload } from '@gpuix/react';
import type { ReactElement } from 'react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  useState,
} from 'react';

import type { NativeApplicationServices } from './application';
import { diagnosticSurfacePosition, nativeRenderingModeLabel } from './diagnostic-mode';
import { nativeGitStatusForThread } from './git-status-state';
import {
  createMessageContentPreview,
  MESSAGE_CONTENT_COLLAPSED_CHARACTERS,
  MESSAGE_CONTENT_COLLAPSED_LINES,
  nextMessageContentPreviewLength,
} from './message-content-preview';
import { assistantMessageUsesRichPresentation } from './message-render-mode';
import { NATIVE_HOST_FOCUS_EVIDENCE } from './platform/lifecycle';
import { resolveFileTreeVisibility, resolveSidebarVisibility } from './responsive-layout';
import {
  formatSidebarRelativeTime,
  recentSidebarThreads,
  sidebarThreadStatus,
  sidebarThreadSummary,
  visibleProjectThreads,
} from './sidebar-model';
import { createThreadRenderItems, type ThreadRenderItem } from './thread-render-items';
import {
  selectProjectName,
  selectThreadPermission,
  selectThreadRecord,
  selectThreadRun,
  selectThreadViewerShareLevel,
  selectThreadWorkspaceData,
} from './thread-render-selectors';
import {
  createToolOutputPreview,
  nextToolOutputPreviewLength,
  TOOL_OUTPUT_COLLAPSED_CHARACTERS,
  TOOL_OUTPUT_COLLAPSED_LINES,
} from './tool-output-preview';

function useStore<T>(store: StoreApi<T>): T {
  return useSyncExternalStore(
    useCallback((notify) => store.subscribe(() => notify()), [store]),
    store.getState,
    store.getInitialState,
  );
}

function useNativeColors() {
  return useGpuixUiTheme().colors;
}

function useStoreValue<T, U>(store: StoreApi<T>, selector: (state: T) => U): U {
  return useSyncExternalStore(
    useCallback((notify) => store.subscribe(() => notify()), [store]),
    useCallback(() => selector(store.getState()), [selector, store]),
    useCallback(() => selector(store.getInitialState()), [selector, store]),
  );
}

const selectSelectedThreadId = (state: { selectedThreadId: string | null }) =>
  state.selectedThreadId;

const NativeButton = Button;

export const SIDEBAR_RETAINED_WINDOW_SIZE = 48;
const SIDEBAR_WINDOW_BUFFER = 12;
export const THREAD_RETAINED_WINDOW_SIZE = 48;
const THREAD_WINDOW_BUFFER = 12;

export const NativeFileTreeDock = memo(function NativeFileTreeDock({
  application,
  viewportHeight,
}: {
  application: NativeApplicationServices;
  viewportHeight: number;
}) {
  const colors = useNativeColors();
  const state = useStore(application.fileTree.state);
  const threadId = useStoreValue(application.workspaceState, selectSelectedThreadId);
  const thread = useStoreValue(
    application.navigationState,
    useCallback(
      (navigation) => (threadId ? navigation.threadsById[threadId] : undefined),
      [threadId],
    ),
  );
  const project = useStoreValue(
    application.navigationState,
    useCallback(
      (navigation) => (thread?.projectId ? navigation.projectsById[thread.projectId] : undefined),
      [thread?.projectId],
    ),
  );
  const gitStatus = useStoreValue(
    application.gitStatusState,
    useCallback(
      (gitStatuses) => (thread ? nativeGitStatusForThread(gitStatuses, thread) : undefined),
      [thread],
    ),
  );
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<{
    targetKey: string | null;
    path: string;
  } | null>(null);
  const selectedFile = selection?.targetKey === state.targetKey ? selection.path : null;
  const refreshFileTree = useCallback(() => {
    void application.fileTree.refresh();
  }, [application]);
  const selectFile = useCallback(
    (path: string) => setSelection({ targetKey: state.targetKey, path }),
    [state.targetKey],
  );
  const emptyFileTree = useMemo(
    () => (
      <text style={{ color: colors.muted }}>
        {query ? 'No matching files.' : 'No files in this repository.'}
      </text>
    ),
    [colors.muted, query],
  );
  useEffect(() => {
    if (thread) void application.fileTree.loadForThread(thread, project);
    else application.fileTree.clear();
  }, [application, project, thread]);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
        backgroundColor: colors.panel,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 0,
          gap: 6,
          padding: 6,
          borderBottomWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Input
          testId="file-tree-filter"
          value={query}
          placeholder="Filter files…"
          onValueChange={setQuery}
          style={{
            minHeight: 28,
            paddingTop: 5,
            paddingBottom: 5,
            flexGrow: 1,
          }}
        />
        <IconButton
          testId="file-tree-refresh"
          label="Refresh files"
          icon={<Icon name="watcher" size={14} />}
          onPress={refreshFileTree}
          disabled={state.loading || !state.targetKey}
          style={{ width: 28, height: 28 }}
        />
      </div>
      {threadId ? (
        <GitChangesSummary
          testId="files-diff-summary"
          label={thread?.branch ?? 'Changes'}
          files={gitStatus?.dirtyFileCount ?? null}
          added={gitStatus?.linesAdded ?? null}
          deleted={gitStatus?.linesDeleted ?? null}
          style={{ borderTopWidth: 0, borderBottomWidth: 1 }}
        />
      ) : null}
      {state.truncated ? (
        <text style={{ color: colors.warning, fontSize: 10, padding: 6 }}>
          Showing the first 10,000 files
        </text>
      ) : null}
      {state.error && state.files.length > 0 ? (
        <text style={{ color: colors.danger, fontSize: 10, padding: 6 }}>{state.error}</text>
      ) : null}
      {!state.targetKey ? (
        <div
          style={{
            flexGrow: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 12,
          }}
        >
          <text style={{ color: colors.muted }}>Select a thread to browse files.</text>
        </div>
      ) : state.loading && state.files.length === 0 ? (
        <div
          style={{
            flexGrow: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 12,
          }}
        >
          <text style={{ color: colors.muted }}>Loading files…</text>
        </div>
      ) : state.error && state.files.length === 0 ? (
        <StatusCard title="Unable to load files" detail={state.error} tone="danger">
          <NativeButton size="small" onPress={() => void application.fileTree.refresh()}>
            <text>Retry</text>
          </NativeButton>
        </StatusCard>
      ) : (
        <FileTree
          key={state.targetKey}
          testId="native-file-tree"
          files={state.files}
          viewportHeight={viewportHeight}
          query={query}
          selectedFile={selectedFile}
          onFileSelect={selectFile}
          empty={emptyFileTree}
        />
      )}
    </div>
  );
});

function LoginView({ application }: { application: NativeApplicationServices }) {
  const colors = useNativeColors();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (submittedPassword = password, submittedUsername = username) => {
    if (!submittedUsername.trim() || !submittedPassword || pending) return;
    setPending(true);
    setError(null);
    try {
      await application.signIn(submittedUsername.trim(), submittedPassword);
      setPassword('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        width: 420,
        padding: 24,
      }}
    >
      <text style={{ fontSize: 24, fontWeight: 'bold' }}>Sign in to Funny</text>
      <Input
        value={username}
        placeholder="Username"
        autoFocus
        readOnly={pending}
        onValueChange={setUsername}
        onSubmit={(event) => void submit(password, eventValue(event))}
      />
      <Input
        value={password}
        placeholder="Password"
        readOnly={pending}
        onValueChange={setPassword}
        onSubmit={(event) => void submit(eventValue(event))}
      />
      <text style={{ color: colors.warning, fontSize: 12 }}>
        GPUIX 0.5 does not expose secure-text entry; use this experimental login only in a trusted
        environment.
      </text>
      {error ? <text style={{ color: colors.danger }}>{error}</text> : null}
      <NativeButton
        onPress={() => {
          void submit();
        }}
        disabled={pending || !username.trim() || !password}
        testId="login-submit"
      >
        <text>{pending ? 'Signing in…' : 'Sign in'}</text>
      </NativeButton>
    </div>
  );
}

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

const Sidebar = memo(function Sidebar({ application }: { application: NativeApplicationServices }) {
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
          <virtual-list
            itemCount={rows.length}
            windowStart={effectiveWindowStart}
            estimatedItemHeight={56}
            overdraw={240}
            onVisibleRange={updateRetainedWindow}
            style={{ flexGrow: 1, minHeight: 0, width: '100%', gap: 14 }}
          >
            {retainedRows}
          </virtual-list>
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

function extractDiff(content: string): string | null {
  const match = /```diff\s*\n([\s\S]*?)```/.exec(content);
  return match?.[1]?.trim() || null;
}

const ToolCallBlock = memo(function ToolCallBlock({
  richContent,
  toolCall,
}: {
  richContent: boolean;
  toolCall: ToolCall;
}) {
  const colors = useNativeColors();
  const content = toolCall.output ?? toolCall.input;
  const [requestedCharacters, setRequestedCharacters] = useState(TOOL_OUTPUT_COLLAPSED_CHARACTERS);
  const preview = createToolOutputPreview(content, requestedCharacters);
  const collapsed = requestedCharacters <= TOOL_OUTPUT_COLLAPSED_CHARACTERS;
  return (
    <ConversationRow>
      <ToolCallCard
        title={toolCall.name}
        status={toolCall.output ? 'completed' : 'running'}
        tone="neutral"
      >
        {richContent ? (
          <code
            code={preview.content}
            language="json"
            style={collapsed ? { lineClamp: TOOL_OUTPUT_COLLAPSED_LINES } : undefined}
          />
        ) : (
          <text style={collapsed ? { lineClamp: TOOL_OUTPUT_COLLAPSED_LINES } : undefined}>
            {preview.content}
          </text>
        )}
        {preview.remainingCharacters > 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <text style={{ color: colors.muted, fontSize: 11 }}>
              {`${preview.remainingCharacters.toLocaleString()} characters hidden`}
            </text>
            <NativeButton
              testId={`tool-output-more-${toolCall.id}`}
              onPress={() =>
                setRequestedCharacters((current) =>
                  nextToolOutputPreviewLength(current, content.length),
                )
              }
            >
              <text>{collapsed ? 'Show output' : 'Show more'}</text>
            </NativeButton>
          </div>
        ) : null}
        {preview.visibleCharacters > TOOL_OUTPUT_COLLAPSED_CHARACTERS ? (
          <NativeButton
            testId={`tool-output-collapse-${toolCall.id}`}
            onPress={() => setRequestedCharacters(TOOL_OUTPUT_COLLAPSED_CHARACTERS)}
          >
            <text>Collapse output</text>
          </NativeButton>
        ) : null}
      </ToolCallCard>
    </ConversationRow>
  );
});

interface MessageRowProps {
  message: ThreadWorkspaceData['messagesById'][string] | undefined;
  messageId: string;
  richContent: boolean;
}

export const NATIVE_DIFF_INITIAL_MAX_LINES = 120;

export function ExpandableNativeDiff({
  patch,
  testId,
}: {
  patch: string;
  testId?: string;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const showAllLines = useCallback(() => setExpanded(true), []);
  return (
    <diff
      testId={testId}
      patch={patch}
      wordDiff
      maxLines={expanded ? undefined : NATIVE_DIFF_INITIAL_MAX_LINES}
      onShowMore={expanded ? undefined : showAllLines}
    />
  );
}

export function areMessageRowsEqual(previous: MessageRowProps, next: MessageRowProps): boolean {
  return (
    previous.message === next.message &&
    previous.messageId === next.messageId &&
    previous.richContent === next.richContent
  );
}

const MessageRow = memo(function MessageRow({ message, messageId, richContent }: MessageRowProps) {
  const colors = useNativeColors();
  const content = typeof message?.content === 'string' ? message.content : '';
  const [requestedCharacters, setRequestedCharacters] = useState(
    MESSAGE_CONTENT_COLLAPSED_CHARACTERS,
  );
  const preview = createMessageContentPreview(content, requestedCharacters);
  if (!message || typeof message.content !== 'string') {
    return (
      <ConversationRow>
        <StatusCard title="Unsupported message" detail={messageId} tone="danger" />
      </ConversationRow>
    );
  }
  const collapsed = requestedCharacters <= MESSAGE_CONTENT_COLLAPSED_CHARACTERS;
  const renderRichAssistant = assistantMessageUsesRichPresentation(richContent, message.delivery);
  const diff = preview.remainingCharacters === 0 ? extractDiff(content) : null;
  const body = (
    <>
      {message.role === 'user' ? (
        <text
          style={{
            color: colors.inverseText,
            lineClamp: collapsed ? MESSAGE_CONTENT_COLLAPSED_LINES : undefined,
          }}
        >
          {preview.content}
        </text>
      ) : (
        <AssistantMessage source={preview.content} rich={renderRichAssistant} />
      )}
      {preview.remainingCharacters > 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <text
            style={{
              color: message.role === 'user' ? colors.inverseText : colors.muted,
              fontSize: 11,
            }}
          >
            {`${preview.remainingCharacters.toLocaleString()} message characters hidden`}
          </text>
          <NativeButton
            testId={`message-content-more-${message.id}`}
            variant="ghost"
            size="small"
            onPress={() =>
              setRequestedCharacters((current) =>
                nextMessageContentPreviewLength(current, content.length),
              )
            }
          >
            <text>{collapsed ? 'Show message' : 'Show more'}</text>
          </NativeButton>
        </div>
      ) : null}
      {preview.visibleCharacters > MESSAGE_CONTENT_COLLAPSED_CHARACTERS ? (
        <NativeButton
          testId={`message-content-collapse-${message.id}`}
          variant="ghost"
          size="small"
          onPress={() => setRequestedCharacters(MESSAGE_CONTENT_COLLAPSED_CHARACTERS)}
        >
          <text>Collapse message</text>
        </NativeButton>
      ) : null}
      {renderRichAssistant && diff ? (
        <ExpandableNativeDiff testId={`message-diff-${message.id}`} patch={diff} />
      ) : null}
      {message.images?.length ? (
        <text style={{ color: colors.warning }}>Attachments: {message.images.length}</text>
      ) : null}
    </>
  );
  return (
    <ConversationRow testId={`message-${message.id}`}>
      {message.role === 'user' ? <UserMessageCard>{body}</UserMessageCard> : body}
    </ConversationRow>
  );
}, areMessageRowsEqual);

export const PermissionCard = memo(function PermissionCard({
  threadId,
  application,
}: {
  threadId: string;
  application: NativeApplicationServices;
}) {
  const colors = useNativeColors();
  const permission = useStoreValue(
    application.workspaceState,
    useCallback((workspace) => selectThreadPermission(workspace, threadId), [threadId]),
  );
  const [pending, setPending] = useState(false);
  if (!permission) return null;
  const respond = async (decision: 'allow_once' | 'deny') => {
    if (pending || permission.status !== 'active') return;
    setPending(true);
    try {
      await application.commands.respondPermission({
        threadId,
        runId: permission.runId,
        requestId: permission.requestId,
        decision,
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <UiPermissionCard
      testId={`permission-${permission.requestId}`}
      title={permission.status === 'active' ? 'Permission required' : 'Permission resolved'}
      detail={`${permission.toolName} · run ${permission.runId} · request ${permission.requestId}`}
      status={permission.status}
      tone="warning"
    >
      {permission.toolInput ? <code code={permission.toolInput} language="json" /> : null}
      <text style={{ color: colors.muted }}>
        Allowing this request may execute a tool with access to the current project environment.
      </text>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
        <NativeButton
          onPress={() => {
            void respond('allow_once');
          }}
          disabled={pending || permission.status !== 'active'}
        >
          <text>Allow once</text>
        </NativeButton>
        <NativeButton
          onPress={() => {
            void respond('deny');
          }}
          disabled={pending || permission.status !== 'active'}
        >
          <text>Deny</text>
        </NativeButton>
      </div>
    </UiPermissionCard>
  );
});

export const ThreadControls = memo(function ThreadControls({
  threadId,
  application,
}: {
  threadId: string;
  application: NativeApplicationServices;
}) {
  const colors = useNativeColors();
  const run = useStoreValue(
    application.workspaceState,
    useCallback((workspace) => selectThreadRun(workspace, threadId), [threadId]),
  );
  const viewerShareLevel = useStoreValue(
    application.navigationState,
    useCallback((navigation) => selectThreadViewerShareLevel(navigation, threadId), [threadId]),
  );
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const canSteer = !viewerShareLevel || viewerShareLevel === 'steer';
  const active = ['setting_up', 'pending', 'running'].includes(run?.status ?? '');
  const waiting = run?.status === 'waiting' && !!run.runId;
  const lifecycle = !canSteer
    ? 'read-only'
    : pending
      ? 'pending'
      : active
        ? 'running'
        : waiting
          ? 'waiting'
          : 'idle';
  const submit = async (submittedContent = content) => {
    const trimmed = submittedContent.trim();
    if (!trimmed || pending || !canSteer) return;
    setPending(true);
    try {
      const ok = waiting
        ? await application.commands.resumeRun({
            threadId,
            runId: run.runId as string,
            content: trimmed,
          })
        : await application.commands.submitPrompt({
            threadId,
            content: trimmed,
            optimisticMessage: {
              id: `native-${crypto.randomUUID()}`,
              threadId,
              role: 'user',
              content: trimmed,
              timestamp: new Date().toISOString(),
            },
          });
      if (ok) {
        setContent((current) => (current === submittedContent ? '' : current));
      }
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        gap: 8,
        paddingTop: 8,
        paddingBottom: 12,
        paddingLeft: 16,
        paddingRight: 16,
        backgroundColor: colors.background,
      }}
    >
      <div style={{ width: '100%', maxWidth: 768, alignSelf: 'center' }}>
        <PermissionCard threadId={threadId} application={application} />
      </div>
      <PromptComposer lifecycle={lifecycle}>
        <PromptEditorSurface>
          <Textarea
            testId="thread-prompt"
            value={content}
            placeholder={canSteer ? 'Send a message…' : 'This shared thread is read-only'}
            readOnly={!canSteer}
            minRows={2}
            maxRows={7}
            style={{
              backgroundColor: colors.raised,
              borderWidth: 0,
              padding: 4,
            }}
            onValueChange={setContent}
            onSubmit={(event) => void submit(eventValue(event))}
          />
        </PromptEditorSurface>
        <ComposerActions>
          <ComposerContext>
            <text>{`Native · ${waiting ? 'Waiting' : active ? 'Running' : 'Auto Edit'}`}</text>
          </ComposerContext>
          <div style={{ display: 'flex', flexDirection: 'row', gap: 5 }}>
            {active ? (
              <IconButton
                testId="run-stop"
                label="Stop agent"
                variant="danger"
                icon={<Icon name="stop" />}
                onPress={() => void application.commands.stopRun(threadId)}
                disabled={application.commands.isStopPending(threadId)}
              />
            ) : null}
            <IconButton
              testId="prompt-submit"
              label={waiting ? 'Respond and resume' : 'Send message'}
              variant="primary"
              icon={<Icon name="send" color={colors.accentForeground} />}
              onPress={() => void submit()}
              disabled={!canSteer || pending || !content.trim()}
            />
          </div>
        </ComposerActions>
      </PromptComposer>
    </div>
  );
});

type ThreadTranscriptItem =
  | ThreadRenderItem
  | {
      id: 'load-older';
      key: 'load-older';
      kind: 'load-older';
    };

const LOAD_OLDER_ITEM: ThreadTranscriptItem = {
  id: 'load-older',
  key: 'load-older',
  kind: 'load-older',
};

const ThreadTranscript = memo(function ThreadTranscript({
  application,
  data,
  onHistoryList,
  renderItems,
  richContent,
  threadId,
}: {
  application: NativeApplicationServices;
  data: ThreadWorkspaceData;
  onHistoryList?: (id: number | null) => void;
  renderItems: readonly ThreadRenderItem[];
  richContent: boolean;
  threadId: string;
}) {
  const colors = useNativeColors();
  const items = useMemo<ThreadTranscriptItem[]>(
    () => (data.hasMore ? [LOAD_OLDER_ITEM, ...renderItems] : [...renderItems]),
    [data.hasMore, renderItems],
  );
  const followsTailRef = useRef(true);
  const [retainedState, setRetainedState] = useState(() => ({
    items,
    start: maximumWindowStart(items.length, THREAD_RETAINED_WINDOW_SIZE),
  }));
  let currentRetainedState = retainedState;
  if (retainedState.items !== items) {
    const shiftedStart = shiftedWindowStartForItems(
      retainedState.start,
      retainedState.items,
      items,
    );
    currentRetainedState = {
      items,
      start: followsTailRef.current
        ? maximumWindowStart(items.length, THREAD_RETAINED_WINDOW_SIZE)
        : clampWindowStart(shiftedStart, items.length, THREAD_RETAINED_WINDOW_SIZE),
    };
    setRetainedState(currentRetainedState);
  }
  const effectiveWindowStart = followsTailRef.current
    ? maximumWindowStart(items.length, THREAD_RETAINED_WINDOW_SIZE)
    : clampWindowStart(currentRetainedState.start, items.length, THREAD_RETAINED_WINDOW_SIZE);
  const retainedItems = items.slice(
    effectiveWindowStart,
    effectiveWindowStart + THREAD_RETAINED_WINDOW_SIZE,
  );
  const updateRetainedWindow = useCallback(
    (event: EventPayload) => {
      const visibleStart = Math.max(0, Math.floor(event.startIndex ?? 0));
      const visibleEnd = Math.max(visibleStart + 1, Math.ceil(event.endIndex ?? visibleStart + 1));
      followsTailRef.current = visibleEnd >= items.length - 1;
      setRetainedState((current) => ({
        items,
        start: windowStartForVisibleRange({
          currentStart: current.items === items ? current.start : effectiveWindowStart,
          itemCount: items.length,
          windowSize: THREAD_RETAINED_WINDOW_SIZE,
          buffer: THREAD_WINDOW_BUFFER,
          visibleStart,
          visibleEnd,
        }),
      }));
    },
    [effectiveWindowStart, items],
  );

  return (
    <virtual-list
      ref={(instance) => onHistoryList?.(instance?.id ?? null)}
      alignment="bottom"
      followTail
      itemCount={items.length}
      windowStart={effectiveWindowStart}
      onVisibleRange={updateRetainedWindow}
      overdraw={360}
      estimatedItemHeight={220}
      style={{
        flexGrow: 1,
        minHeight: 0,
        width: '100%',
        backgroundColor: colors.background,
      }}
    >
      {retainedItems.map((item) => {
        if (item.kind === 'load-older') {
          return (
            <ConversationRow key={item.key}>
              <NativeButton
                variant="ghost"
                size="small"
                onPress={() => {
                  void application.data.loadOlder(threadId);
                }}
                disabled={data.loading}
              >
                <text>{data.loading ? 'Loading…' : 'Load older messages'}</text>
              </NativeButton>
            </ConversationRow>
          );
        }
        if (item.kind === 'message') {
          return (
            <MessageRow
              key={item.key}
              message={data.messagesById[item.id]}
              messageId={item.id}
              richContent={richContent}
            />
          );
        }
        const toolCall = data.toolCallsById[item.id];
        return toolCall ? (
          <ToolCallBlock key={item.key} richContent={richContent} toolCall={toolCall} />
        ) : null;
      })}
    </virtual-list>
  );
});

function useRealtimeState(application: NativeApplicationServices) {
  return useSyncExternalStore(
    useCallback((notify) => application.realtime.subscribe(() => notify()), [application]),
    () => application.realtime.current(),
    () => application.realtime.current(),
  );
}

export const SelectedThreadHeader = memo(function SelectedThreadHeader({
  application,
  diagnostics,
  filesVisible,
  onResetFrameStats,
  onToggleFiles,
  onToggleRichContent,
  onToggleSidebar,
  richContent,
  sidebarVisible,
  threadId,
}: {
  application: NativeApplicationServices;
  diagnostics: boolean;
  filesVisible: boolean;
  onResetFrameStats?: () => void;
  onToggleFiles(): void;
  onToggleRichContent(): void;
  onToggleSidebar(): void;
  richContent: boolean;
  sidebarVisible: boolean;
  threadId: string;
}) {
  const thread = useStoreValue(
    application.navigationState,
    useCallback((navigation) => selectThreadRecord(navigation, threadId), [threadId]),
  );
  const projectName = useStoreValue(
    application.navigationState,
    useCallback(
      (navigation) => selectProjectName(navigation, thread?.projectId),
      [thread?.projectId],
    ),
  );
  const run = useStoreValue(
    application.workspaceState,
    useCallback((workspace) => selectThreadRun(workspace, threadId), [threadId]),
  );
  const realtime = useRealtimeState(application);
  return (
    <ThreadHeader
      title={thread?.title ?? 'Thread'}
      metadata={`${thread?.projectId ? (projectName ?? 'Project') : 'Scratch'} · ${run?.status ?? thread?.status ?? 'idle'} · ${realtime.phase}`}
      leading={
        <IconButton
          testId="sidebar-toggle"
          label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          selected={sidebarVisible}
          icon={<Icon name="navigation" />}
          onPress={onToggleSidebar}
        />
      }
      actions={
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <IconButton
            testId="file-tree-toggle"
            label={filesVisible ? 'Hide files' : 'Show files'}
            selected={filesVisible}
            icon={<Icon name="file" />}
            onPress={onToggleFiles}
          />
          {diagnostics ? (
            <>
              <NativeButton
                testId="rich-content-toggle"
                variant="ghost"
                size="small"
                onPress={onToggleRichContent}
              >
                <text>{nativeRenderingModeLabel(richContent)}</text>
              </NativeButton>
              {onResetFrameStats ? (
                <NativeButton
                  testId="frame-stats-reset"
                  variant="ghost"
                  size="small"
                  onPress={onResetFrameStats}
                >
                  <text>Reset stats</text>
                </NativeButton>
              ) : null}
            </>
          ) : null}
        </div>
      }
    />
  );
});

const SelectedThreadContent = memo(function SelectedThreadContent({
  application,
  onHistoryList,
  richContent,
  threadId,
}: {
  application: NativeApplicationServices;
  onHistoryList?: (id: number | null) => void;
  richContent: boolean;
  threadId: string;
}) {
  const data = useStoreValue(
    application.workspaceState,
    useCallback((workspace) => selectThreadWorkspaceData(workspace, threadId), [threadId]),
  );
  const realtime = useRealtimeState(application);
  const renderItems = useMemo(
    () => createThreadRenderItems(data?.messageIds ?? [], data?.toolCallIdsByMessage ?? {}),
    [data?.messageIds, data?.toolCallIdsByMessage],
  );
  return (
    <>
      {realtime.phase === 'disconnected' || realtime.phase === 'error' ? (
        <ConversationRow style={{ paddingLeft: 16, paddingRight: 16 }}>
          <StatusCard
            title="Connection interrupted"
            detail={realtime.error ?? 'Reconnecting…'}
            status="disconnected"
            tone="danger"
          />
        </ConversationRow>
      ) : null}
      {data?.error ? (
        <ConversationRow style={{ paddingLeft: 16, paddingRight: 16 }}>
          <StatusCard title="Unable to load thread" detail={data.error} tone="danger">
            <NativeButton
              size="small"
              onPress={() => {
                void application.data.selectThread(threadId);
              }}
            >
              <text>Retry</text>
            </NativeButton>
          </StatusCard>
        </ConversationRow>
      ) : data?.loading && data.messageIds.length === 0 ? (
        <ConversationRow>
          <StatusCard title="Loading thread…" status="pending" />
        </ConversationRow>
      ) : !data || data.messageIds.length === 0 ? (
        <ConversationRow>
          <StatusCard title="This thread has no messages" detail="Send a message to begin." />
        </ConversationRow>
      ) : (
        <ThreadTranscript
          key={threadId}
          application={application}
          data={data}
          onHistoryList={onHistoryList}
          renderItems={renderItems}
          richContent={richContent}
          threadId={threadId}
        />
      )}
    </>
  );
});

const SelectedThreadView = memo(function SelectedThreadView({
  application,
  diagnostics,
  filesVisible,
  onHistoryList,
  onResetFrameStats,
  onToggleFiles,
  onToggleSidebar,
  sidebarVisible,
  threadId,
}: {
  application: NativeApplicationServices;
  diagnostics: boolean;
  filesVisible: boolean;
  onHistoryList?: (id: number | null) => void;
  onResetFrameStats?: () => void;
  onToggleFiles(): void;
  onToggleSidebar(): void;
  sidebarVisible: boolean;
  threadId: string;
}) {
  const [richContent, setRichContent] = useState(true);
  const toggleRichContent = useCallback(() => setRichContent((current) => !current), []);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minWidth: 0,
        height: '100%',
      }}
    >
      <SelectedThreadHeader
        application={application}
        diagnostics={diagnostics}
        filesVisible={filesVisible}
        onResetFrameStats={onResetFrameStats}
        onToggleFiles={onToggleFiles}
        onToggleRichContent={toggleRichContent}
        onToggleSidebar={onToggleSidebar}
        richContent={richContent}
        sidebarVisible={sidebarVisible}
        threadId={threadId}
      />
      <SelectedThreadContent
        application={application}
        onHistoryList={onHistoryList}
        richContent={richContent}
        threadId={threadId}
      />
      <ThreadControls threadId={threadId} application={application} />
    </div>
  );
});

const ThreadView = memo(function ThreadView({
  application,
  diagnostics,
  filesVisible,
  onHistoryList,
  onResetFrameStats,
  onToggleFiles,
  onToggleSidebar,
  sidebarVisible,
}: {
  application: NativeApplicationServices;
  diagnostics: boolean;
  filesVisible: boolean;
  onHistoryList?: (id: number | null) => void;
  onResetFrameStats?: () => void;
  onToggleFiles(): void;
  onToggleSidebar(): void;
  sidebarVisible: boolean;
}) {
  const colors = useNativeColors();
  const threadId = useStoreValue(application.workspaceState, selectSelectedThreadId);
  if (!threadId)
    return (
      <div style={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}>
        <text style={{ color: colors.muted }}>Select a thread.</text>
      </div>
    );
  return (
    <SelectedThreadView
      application={application}
      diagnostics={diagnostics}
      filesVisible={filesVisible}
      onHistoryList={onHistoryList}
      onResetFrameStats={onResetFrameStats}
      onToggleFiles={onToggleFiles}
      onToggleSidebar={onToggleSidebar}
      sidebarVisible={sidebarVisible}
      threadId={threadId}
    />
  );
});

function AuthenticatedShell({
  application,
  diagnostics,
  onHistoryList,
  onResetFrameStats,
}: {
  application: NativeApplicationServices;
  diagnostics: boolean;
  onHistoryList?: (id: number | null) => void;
  onResetFrameStats?: () => void;
}) {
  const colors = useNativeColors();
  const { width, height } = useWindowSize({ intervalMs: 250 });
  const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
  const [filesOverride, setFilesOverride] = useState<boolean | null>(null);
  const sidebarVisible = resolveSidebarVisibility(width, sidebarOverride);
  const filesVisible = resolveFileTreeVisibility(width, filesOverride);
  const toggleSidebar = useCallback(
    () => setSidebarOverride((current) => !resolveSidebarVisibility(width, current)),
    [width],
  );
  const toggleFiles = useCallback(
    () => setFilesOverride((current) => !resolveFileTreeVisibility(width, current)),
    [width],
  );
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height: '100%',
        minHeight: 0,
        position: 'relative',
      }}
    >
      <DockLayout.Root
        key={`${sidebarVisible ? 'expanded' : 'compact'}-${filesVisible ? 'files' : 'no-files'}`}
        defaultValue={application.dockLayoutPreference.current()}
        onValueCommit={(layout) => application.dockLayoutPreference.save(layout)}
      >
        {sidebarVisible ? (
          <DockLayout.Panel id="navigation" defaultSize={300} minSize={260} maxSize={600}>
            <DockLayout.Handle testId="navigation-dock-handle">
              <text style={{ color: colors.muted, fontSize: 10 }}>Navigation</text>
            </DockLayout.Handle>
            <Sidebar application={application} />
          </DockLayout.Panel>
        ) : null}
        {filesVisible ? (
          <DockLayout.Panel id="files" defaultSize={300} minSize={240} maxSize={600}>
            <DockLayout.Handle testId="files-dock-handle">
              <text style={{ color: colors.muted, fontSize: 10 }}>Files</text>
            </DockLayout.Handle>
            <NativeFileTreeDock application={application} viewportHeight={height} />
          </DockLayout.Panel>
        ) : null}
        <DockLayout.Panel id="conversation" minSize={400}>
          <DockLayout.Handle testId="conversation-dock-handle">
            <text style={{ color: colors.muted, fontSize: 10 }}>Conversation</text>
          </DockLayout.Handle>
          <ThreadView
            application={application}
            diagnostics={diagnostics}
            sidebarVisible={sidebarVisible}
            filesVisible={filesVisible}
            onToggleSidebar={toggleSidebar}
            onToggleFiles={toggleFiles}
            onHistoryList={onHistoryList}
            onResetFrameStats={onResetFrameStats}
          />
        </DockLayout.Panel>
      </DockLayout.Root>
      {diagnostics ? (
        <div
          testId="diagnostic-surface"
          style={{
            ...diagnosticSurfacePosition,
            display: 'flex',
            flexDirection: 'row',
            gap: 5,
            padding: 5,
            backgroundColor: colors.overlay,
            borderWidth: 1,
            borderColor: colors.warning,
            borderRadius: 6,
          }}
        >
          <text style={{ color: colors.warning, fontSize: 11 }}>Diagnostics</text>
          <text style={{ color: colors.muted, fontSize: 11 }}>
            Host focus: {NATIVE_HOST_FOCUS_EVIDENCE.reason}
          </text>
          <NativeButton
            variant="ghost"
            size="small"
            onPress={() => {
              void application.logout();
            }}
          >
            <text>Log out</text>
          </NativeButton>
        </div>
      ) : null}
    </div>
  );
}

export function GpuixClientApp({
  application,
  unsupportedReason,
  diagnostics = false,
  onHistoryList,
  onResetFrameStats,
}: {
  application: NativeApplicationServices;
  unsupportedReason?: string;
  diagnostics?: boolean;
  onHistoryList?: (id: number | null) => void;
  onResetFrameStats?: () => void;
}): ReactElement {
  const auth = useStore(application.authState);
  const status = useStore(application.statusState);
  const themePreference = useStore(application.themePreference.state);
  const theme = useMemo(() => gpuixTheme(themePreference.name), [themePreference.name]);
  const colors = theme.colors;
  return (
    <GpuixUiProvider theme={theme}>
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: '100%',
          backgroundColor: colors.background,
          color: colors.text,
        }}
      >
        {unsupportedReason ? (
          <div style={{ padding: 24, gap: 10 }}>
            <text style={{ color: colors.danger, fontSize: 20 }}>
              GPUIX is unsupported on this host
            </text>
            <text>{unsupportedReason}</text>
            <text style={{ color: colors.muted }}>
              Run `bun run dev:client` to use the web renderer.
            </text>
          </div>
        ) : null}
        {!unsupportedReason &&
        (auth.phase === 'bootstrapping' || status.phase === 'bootstrapping') ? (
          <div style={{ padding: 24 }}>
            <text>Restoring session…</text>
          </div>
        ) : null}
        {!unsupportedReason && status.phase === 'error' ? (
          <div style={{ padding: 24, gap: 10 }}>
            <text style={{ color: colors.danger }}>Recoverable startup error: {status.error}</text>
            <NativeButton
              onPress={() => {
                void application.retry();
              }}
            >
              <text>Retry startup</text>
            </NativeButton>
          </div>
        ) : null}
        {!unsupportedReason &&
        status.phase !== 'error' &&
        (auth.phase === 'anonymous' || auth.phase === 'rejected') ? (
          <div>
            {auth.rejection ? <text style={{ color: colors.danger }}>{auth.rejection}</text> : null}
            <LoginView application={application} />
          </div>
        ) : null}
        {!unsupportedReason && status.phase === 'ready' && auth.phase === 'authenticated' ? (
          <AuthenticatedShell
            application={application}
            diagnostics={diagnostics}
            onHistoryList={onHistoryList}
            onResetFrameStats={onResetFrameStats}
          />
        ) : null}
      </div>
    </GpuixUiProvider>
  );
}
