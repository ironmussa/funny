/** File tree dock of the native app. */

import { IconButton } from '@funny/gpuix-ui/button';
import { FileTree } from '@funny/gpuix-ui/file-tree';
import { Icon } from '@funny/gpuix-ui/icon';
import { Input } from '@funny/gpuix-ui/input';
import { GitChangesSummary } from '@funny/gpuix-ui/powerline';
import { StatusCard } from '@funny/gpuix-ui/status-card';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import type { NativeApplicationServices } from '../application';
import type { NativeFileTreeState } from '../file-tree-state';
import { nativeGitStatusForThread } from '../git-status-state';
import {
  NativeButton,
  selectSelectedThreadId,
  useNativeColors,
  useStore,
  useStoreValue,
} from './hooks';

function fileTreeIdleMessage(state: NativeFileTreeState): string {
  return state.unavailable
    ? 'This thread has no files to browse yet.'
    : 'Select a thread to browse files.';
}

function FileTreeMessage({ children }: { children: string }) {
  const colors = useNativeColors();
  return (
    <div style={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <text style={{ color: colors.muted }}>{children}</text>
    </div>
  );
}

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
  const projectId = thread?.projectId;
  const project = useStoreValue(
    application.navigationState,
    useCallback(
      (navigation) => (projectId ? navigation.projectsById[projectId] : undefined),
      [projectId],
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
        <FileTreeMessage>{fileTreeIdleMessage(state)}</FileTreeMessage>
      ) : state.loading && state.files.length === 0 ? (
        <FileTreeMessage>Loading files…</FileTreeMessage>
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
