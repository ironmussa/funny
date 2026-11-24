import type { CSSProperties } from 'react';

import { setFileMentionDragData } from '@/lib/file-mention-dnd';
import type { TreeRow } from '@/lib/file-tree';
import { cn } from '@/lib/utils';

import { FileTreeFileMenu } from './FileTreeFileMenu';
import { FileCheckbox, FileRowLabel, SubmoduleToggle } from './FileTreeFileRowParts';
import { INDENT_PX, type FileTreeRowCommon } from './row-props';

interface FileTreeFileRowProps {
  row: Extract<TreeRow, { kind: 'file' }>;
  style?: CSSProperties;
  common: FileTreeRowCommon;
  isActive: boolean;
  activeClass: string;
  onFileClick: (path: string) => void;
  checkedFiles?: Set<string>;
  onToggleFile?: (path: string) => void;
  onRevertFile?: (path: string) => void;
  revertLabel?: string;
  onIgnore?: (pattern: string) => void;
  onToggleSubmodule?: (submodulePath: string) => void;
  expandedSubmodules?: Set<string>;
}

export function FileTreeFileRow({
  row,
  style,
  common: {
    fontSize,
    hoverClass,
    testIdPrefix,
    searchQuery,
    hideDiffStats,
    hideStatus,
    diffStatsSize,
    basePath,
    dropdownCloseRef,
    onCopyPath,
    onOpenDirectory,
  },
  isActive,
  activeClass,
  onFileClick,
  checkedFiles,
  onToggleFile,
  onRevertFile,
  revertLabel,
  onIgnore,
  onToggleSubmodule,
  expandedSubmodules,
}: FileTreeFileRowProps) {
  const f = row.file;
  const isSubmodule = f.kind === 'submodule';
  const canExpandSubmodule = isSubmodule && !!onToggleSubmodule;
  const isSubmoduleExpanded = canExpandSubmodule && !!expandedSubmodules?.has(f.path);

  return (
    <div
      className={cn(
        'group flex h-[24px] items-center gap-1.5 cursor-pointer transition-colors overflow-hidden pr-1',
        fontSize,
        isActive ? activeClass : hoverClass,
      )}
      style={{
        ...style,
        paddingLeft: `${8 + row.depth * INDENT_PX}px`,
      }}
      draggable
      onDragStart={(e) => {
        setFileMentionDragData(e.dataTransfer, {
          path: f.path,
          fileType: 'file',
        });
      }}
      data-testid={`${testIdPrefix}-file-${f.path}`}
    >
      {checkedFiles && onToggleFile && (
        <FileCheckbox
          path={f.path}
          checked={checkedFiles.has(f.path)}
          testIdPrefix={testIdPrefix}
          onToggle={onToggleFile}
        />
      )}
      {canExpandSubmodule && (
        <SubmoduleToggle
          path={f.path}
          expanded={isSubmoduleExpanded}
          testIdPrefix={testIdPrefix}
          onToggle={onToggleSubmodule}
        />
      )}
      <button
        type="button"
        onClick={() => {
          if (Date.now() - dropdownCloseRef.current < 400) return;
          onFileClick(f.path);
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <FileRowLabel
          file={f}
          canExpandSubmodule={canExpandSubmodule}
          fontSize={fontSize}
          testIdPrefix={testIdPrefix}
          searchQuery={searchQuery}
          hideDiffStats={hideDiffStats}
          hideStatus={hideStatus}
          diffStatsSize={diffStatsSize}
        />
      </button>
      <FileTreeFileMenu
        path={f.path}
        basePath={basePath}
        testIdPrefix={testIdPrefix}
        dropdownCloseRef={dropdownCloseRef}
        onCopyPath={onCopyPath}
        onOpenDirectory={onOpenDirectory}
        onRevertFile={onRevertFile}
        revertLabel={revertLabel}
        onIgnore={onIgnore}
      />
    </div>
  );
}
