import type { EventPayload, StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import { memo, useCallback, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import {
  buildNormalizedFileTreeRows,
  normalizeFilePaths,
  type NativeFileTreeRow,
} from './file-tree-model';
import {
  FILE_TREE_ESTIMATED_ROW_HEIGHT,
  FILE_TREE_NATIVE_OVERDRAW,
  FILE_TREE_OVERSCAN_ROWS,
  fileTreeWindowSizeForViewport,
  fileTreeWindowSizeForVisibleRange,
} from './file-tree-window';
import { Icon } from './icon';
import { NavItem } from './nav-item';
import { useGpuixUiTheme } from './theme';
import { maximumWindowStart, windowStartForVisibleRange } from './virtual-range';

type DivProps = JSX.IntrinsicElements['div'];
type VirtualListHostProps = Omit<DivProps, 'children' | 'onVisibleRange' | 'style'>;
const NO_COLLAPSED_FOLDERS: ReadonlySet<string> = new Set();
const DEFAULT_VIEWPORT_HEIGHT = 600;

export {
  FILE_TREE_ESTIMATED_ROW_HEIGHT,
  FILE_TREE_MAX_RETAINED_ROWS,
  FILE_TREE_MIN_RETAINED_ROWS,
  FILE_TREE_NATIVE_OVERDRAW,
  FILE_TREE_OVERSCAN_ROWS,
  fileTreeWindowSizeForViewport,
  fileTreeWindowSizeForVisibleRange,
} from './file-tree-window';

export interface FileTreeProps extends Omit<DivProps, 'children' | 'style'> {
  files: readonly string[];
  query?: string;
  selectedFile?: string | null;
  collapsedFolders?: ReadonlySet<string>;
  onCollapsedFoldersChange?: (folders: Set<string>) => void;
  onFileSelect?: (path: string) => void;
  viewportHeight?: number;
  empty?: ReactNode;
  style?: StyleDesc;
}

export const FileTree = memo(function FileTree({
  files,
  query = '',
  selectedFile,
  collapsedFolders: controlledCollapsed,
  onCollapsedFoldersChange,
  onFileSelect,
  viewportHeight = DEFAULT_VIEWPORT_HEIGHT,
  onVisibleRange,
  empty,
  style,
  ...props
}: FileTreeProps): ReactElement {
  const theme = useGpuixUiTheme();
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(() => new Set());
  const collapsedFolders = controlledCollapsed ?? internalCollapsed;
  const normalizedFiles = useMemo(() => normalizeFilePaths(files), [files]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredFiles = useMemo(() => {
    return normalizedQuery
      ? normalizedFiles.filter((path) => path.toLocaleLowerCase().includes(normalizedQuery))
      : normalizedFiles;
  }, [normalizedFiles, normalizedQuery]);
  const effectiveCollapsed = normalizedQuery ? NO_COLLAPSED_FOLDERS : collapsedFolders;
  const rows = useMemo(
    () => buildNormalizedFileTreeRows(filteredFiles, effectiveCollapsed),
    [effectiveCollapsed, filteredFiles],
  );
  const toggleFolder = useCallback(
    (path: string) => {
      const next = new Set(collapsedFolders);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      if (controlledCollapsed) onCollapsedFoldersChange?.(next);
      else setInternalCollapsed(next);
    },
    [collapsedFolders, controlledCollapsed, onCollapsedFoldersChange],
  );

  if (rows.length === 0) {
    return (
      <div
        {...props}
        style={{
          flexGrow: 1,
          minHeight: 0,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 12,
          ...style,
        }}
      >
        {empty ?? <text style={{ color: theme.colors.muted }}>No files</text>}
      </div>
    );
  }

  return (
    <VirtualizedFileTreeRows
      key={normalizedQuery}
      rows={rows}
      collapsedFolders={effectiveCollapsed}
      selectedFile={selectedFile}
      query={query}
      onSelectFolder={toggleFolder}
      onSelectFile={onFileSelect}
      viewportHeight={viewportHeight}
      onVisibleRange={onVisibleRange}
      hostProps={props}
      style={style}
    />
  );
});

function VirtualizedFileTreeRows({
  rows,
  collapsedFolders,
  selectedFile,
  query,
  onSelectFolder,
  onSelectFile,
  viewportHeight,
  onVisibleRange,
  hostProps,
  style,
}: {
  rows: readonly NativeFileTreeRow[];
  collapsedFolders: ReadonlySet<string>;
  selectedFile?: string | null;
  query: string;
  onSelectFolder: (path: string) => void;
  onSelectFile?: (path: string) => void;
  viewportHeight: number;
  onVisibleRange?: (event: EventPayload) => void;
  hostProps: VirtualListHostProps;
  style?: StyleDesc;
}) {
  const viewportWindowSize = fileTreeWindowSizeForViewport(viewportHeight, rows.length);
  const [retainedWindow, setRetainedWindow] = useState<{
    windowStart: number;
    measurement: { viewportHeight: number; windowSize: number } | null;
  }>({ windowStart: 0, measurement: null });
  const retainedWindowSize =
    retainedWindow.measurement?.viewportHeight === viewportHeight
      ? retainedWindow.measurement.windowSize
      : viewportWindowSize;
  const effectiveWindowStart = Math.min(
    retainedWindow.windowStart,
    maximumWindowStart(rows.length, retainedWindowSize),
  );
  const retainedRows = rows.slice(effectiveWindowStart, effectiveWindowStart + retainedWindowSize);
  const updateRetainedWindow = useCallback(
    (event: EventPayload) => {
      onVisibleRange?.(event);
      const visibleStart = Math.max(0, Math.floor(event.startIndex ?? 0));
      const visibleEnd = Math.max(visibleStart + 1, Math.ceil(event.endIndex ?? visibleStart + 1));
      const nextWindowSize = fileTreeWindowSizeForVisibleRange(
        visibleStart,
        visibleEnd,
        rows.length,
      );
      setRetainedWindow((current) => {
        const nextWindowStart = windowStartForVisibleRange({
          currentStart: current.windowStart,
          itemCount: rows.length,
          windowSize: nextWindowSize,
          buffer: FILE_TREE_OVERSCAN_ROWS,
          visibleStart,
          visibleEnd,
        });
        if (
          current.windowStart === nextWindowStart &&
          current.measurement?.viewportHeight === viewportHeight &&
          current.measurement.windowSize === nextWindowSize
        )
          return current;
        return {
          windowStart: nextWindowStart,
          measurement: { viewportHeight, windowSize: nextWindowSize },
        };
      });
    },
    [onVisibleRange, rows.length, viewportHeight],
  );

  return (
    <virtual-list
      {...hostProps}
      itemCount={rows.length}
      windowStart={effectiveWindowStart}
      estimatedItemHeight={FILE_TREE_ESTIMATED_ROW_HEIGHT}
      overdraw={FILE_TREE_NATIVE_OVERDRAW}
      onVisibleRange={updateRetainedWindow}
      style={{ flexGrow: 1, minHeight: 0, width: '100%', gap: 1, ...style }}
    >
      {retainedRows.map((row) => (
        <FileTreeRow
          key={`${row.kind}:${row.path}`}
          row={row}
          collapsed={row.kind === 'folder' && collapsedFolders.has(row.path)}
          selected={row.kind === 'file' && selectedFile === row.path}
          query={query}
          onSelect={row.kind === 'folder' ? onSelectFolder : onSelectFile}
        />
      ))}
    </virtual-list>
  );
}

const FileTreeRow = memo(function FileTreeRow({
  row,
  collapsed,
  selected,
  query,
  onSelect,
}: {
  row: NativeFileTreeRow;
  collapsed: boolean;
  selected: boolean;
  query: string;
  onSelect?: (path: string) => void;
}) {
  const theme = useGpuixUiTheme();
  return (
    <NavItem
      testId={`file-tree-${row.kind}-${row.path}`}
      selected={selected}
      onSelect={() => onSelect?.(row.path)}
      highlight={query ? { query, color: theme.colors.accent } : null}
      style={{ minHeight: 24, padding: 3, paddingLeft: 6 + row.depth * 14 }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
        }}
      >
        {row.kind === 'folder' ? (
          <>
            <Icon name={collapsed ? 'expand' : 'collapse'} size={11} color={theme.colors.muted} />
            <Icon name="project" size={13} color={theme.colors.muted} />
          </>
        ) : (
          <>
            <div style={{ width: 11, flexShrink: 0 }} />
            <Icon name="file" size={13} color={theme.colors.muted} />
          </>
        )}
        <text
          style={{
            color: selected ? theme.colors.text : theme.colors.muted,
            lineClamp: 1,
          }}
        >
          {row.name}
        </text>
      </div>
    </NavItem>
  );
});
