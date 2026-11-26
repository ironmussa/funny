/** Selected thread: header, transcript and controls. */

import { IconButton } from '@funny/gpuix-ui/button';
import { ConversationRow } from '@funny/gpuix-ui/conversation';
import { Icon } from '@funny/gpuix-ui/icon';
import { StatusCard } from '@funny/gpuix-ui/status-card';
import { ThreadHeader } from '@funny/gpuix-ui/thread-header';
import { memo, useCallback, useMemo, useState } from 'react';

import type { NativeApplicationServices } from '../application';
import { nativeRenderingModeLabel } from '../diagnostic-mode';
import { createThreadRenderItems } from '../thread-render-items';
import {
  selectProjectName,
  selectThreadRecord,
  selectThreadRun,
  selectThreadWorkspaceData,
} from '../thread-render-selectors';
import {
  NativeButton,
  selectSelectedThreadId,
  useNativeColors,
  useRealtimeState,
  useStoreValue,
} from './hooks';
import { ThreadControls } from './thread-controls';
import { ThreadTranscript } from './thread-transcript';

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

export const ThreadView = memo(function ThreadView({
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
