import type { TestFile, TestFileStatus, TestSpec } from '@funny/shared';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileExtensionIcon } from '@/lib/file-icons';
import { cn } from '@/lib/utils';

const INDENT_PX = 12;

interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: TreeNode[];
}

function buildTree(files: TestFile[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');

      let node = current.find((n) => n.name === name);
      if (!node) {
        node = { name, path, isFolder: !isLast, children: [] };
        current.push(node);
      }
      current = node.children;
    }
  }

  return root;
}

function StatusDot({ status }: { status: TestFileStatus | undefined }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3 w-3 animate-spin text-blue-500" />;
    case 'passed':
      return <CheckCircle2 className="h-3 w-3 text-green-500" />;
    case 'failed':
      return <XCircle className="h-3 w-3 text-red-500" />;
    case 'stopped':
      return <Circle className="h-3 w-3 text-yellow-500" />;
    default:
      return <Circle className="h-3 w-3 text-muted-foreground/30" />;
  }
}

/* ─── Individual spec (test) row ────────────────────────── */

function SpecItem({
  spec,
  depth,
  isRunning,
  onRunSpec,
}: {
  spec: TestSpec;
  depth: number;
  isRunning: boolean;
  onRunSpec: (file: string, line: number) => void;
}) {
  return (
    <div
      data-testid={`test-spec-${spec.file}-${spec.line}`}
      className="group flex h-6 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/50"
      style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
    >
      <Circle className="h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/30" />
      <span className="flex-1 truncate font-mono-explorer text-xs" title={spec.title}>
        {spec.title}
      </span>
      <Button
        data-testid={`test-spec-play-${spec.file}-${spec.line}`}
        variant="ghost"
        size="icon"
        className="h-5 w-5 opacity-0 group-hover:opacity-100"
        disabled={isRunning}
        onClick={() => onRunSpec(spec.file, spec.line)}
      >
        <Play className="h-2.5 w-2.5" />
      </Button>
    </div>
  );
}

/* ─── Tree item (folder or file) ────────────────────────── */

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
  expandedFiles: Set<string>;
  toggleFile: (path: string) => void;
  fileStatuses: Record<string, TestFileStatus>;
  fileSpecs: Record<string, TestSpec[]>;
  specsLoading: Record<string, boolean>;
  isRunning: boolean;
  onRunFile: (file: string) => void;
  onRunSpec: (file: string, line: number) => void;
  onExpandFile: (file: string) => void;
}

function TreeItem({
  node,
  depth,
  expandedFolders,
  toggleFolder,
  expandedFiles,
  toggleFile,
  fileStatuses,
  fileSpecs,
  specsLoading,
  isRunning,
  onRunFile,
  onRunSpec,
  onExpandFile,
}: TreeItemProps) {
  const isExpanded = expandedFolders.has(node.path);

  if (node.isFolder) {
    return (
      <>
        <div
          data-testid={`test-folder-${node.path}`}
          onClick={() => toggleFolder(node.path)}
          className={cn(
            'flex h-6 cursor-pointer select-none items-center gap-1.5 text-xs',
            'text-muted-foreground transition-colors hover:bg-sidebar-accent/50',
          )}
          style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 flex-shrink-0 transition-transform',
              isExpanded && 'rotate-90',
            )}
          />
          {isExpanded ? (
            <FolderOpen className="h-4 w-4 flex-shrink-0 text-muted-foreground/70" />
          ) : (
            <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground/70" />
          )}
          <span className="flex-1 truncate font-mono-explorer text-xs">{node.name}</span>
        </div>
        {isExpanded &&
          node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
              expandedFiles={expandedFiles}
              toggleFile={toggleFile}
              fileStatuses={fileStatuses}
              fileSpecs={fileSpecs}
              specsLoading={specsLoading}
              isRunning={isRunning}
              onRunFile={onRunFile}
              onRunSpec={onRunSpec}
              onExpandFile={onExpandFile}
            />
          ))}
      </>
    );
  }

  // File node — expandable to show individual specs
  const status = fileStatuses[node.path];
  const isFileExpanded = expandedFiles.has(node.path);
  const specs = fileSpecs[node.path];
  const isSpecsLoading = specsLoading[node.path];

  const handleToggleFile = () => {
    toggleFile(node.path);
    onExpandFile(node.path);
  };

  return (
    <>
      <div
        data-testid={`test-file-${node.path}`}
        className={cn(
          'group flex h-6 items-center gap-1.5 text-xs cursor-pointer transition-colors',
          status === 'running'
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'hover:bg-sidebar-accent/50 text-muted-foreground',
        )}
        style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
        onClick={handleToggleFile}
      >
        <button
          data-testid={`test-file-expand-${node.path}`}
          className="flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            handleToggleFile();
          }}
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 flex-shrink-0 transition-transform text-muted-foreground',
              isFileExpanded && 'rotate-90',
            )}
          />
        </button>
        <FileExtensionIcon
          filePath={node.path}
          className="h-4 w-4 flex-shrink-0 text-muted-foreground/80"
        />
        <span className="flex-1 truncate font-mono-explorer text-xs">{node.name}</span>
        <StatusDot status={status} />
        <Button
          data-testid={`test-play-${node.path}`}
          variant="ghost"
          size="icon"
          className="h-5 w-5 opacity-0 group-hover:opacity-100"
          disabled={isRunning}
          onClick={(e) => {
            e.stopPropagation();
            onRunFile(node.path);
          }}
        >
          <Play className="h-3 w-3" />
        </Button>
      </div>

      {/* Expanded specs */}
      {isFileExpanded &&
        (isSpecsLoading ? (
          <div
            className="flex h-6 items-center gap-2 text-xs text-muted-foreground"
            style={{ paddingLeft: `${8 + (depth + 1) * INDENT_PX}px` }}
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Discovering tests...
          </div>
        ) : specs && specs.length > 0 ? (
          specs.map((spec) => (
            <SpecItem
              key={`${spec.file}:${spec.line}`}
              spec={spec}
              depth={depth + 1}
              isRunning={isRunning}
              onRunSpec={onRunSpec}
            />
          ))
        ) : specs ? (
          <div
            className="flex h-6 items-center text-xs text-muted-foreground"
            style={{ paddingLeft: `${8 + (depth + 1) * INDENT_PX}px` }}
          >
            No tests found
          </div>
        ) : null)}
    </>
  );
}

/* ─── File browser ──────────────────────────────────────── */

interface TestFileBrowserProps {
  files: TestFile[];
  fileStatuses: Record<string, TestFileStatus>;
  fileSpecs: Record<string, TestSpec[]>;
  specsLoading: Record<string, boolean>;
  isRunning: boolean;
  isLoading: boolean;
  onRunFile: (file: string) => void;
  onRunSpec: (file: string, line: number) => void;
  onExpandFile: (file: string) => void;
  onRunAll: () => void;
}

export function TestFileBrowser({
  files,
  fileStatuses,
  fileSpecs,
  specsLoading,
  isRunning,
  isLoading,
  onRunFile,
  onRunSpec,
  onExpandFile,
  onRunAll,
}: TestFileBrowserProps) {
  const [search, setSearch] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const filteredFiles = useMemo(() => {
    if (!search) return files;
    const lower = search.toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(lower));
  }, [files, search]);

  const tree = useMemo(() => buildTree(filteredFiles), [filteredFiles]);

  // Auto-expand all folders when searching or when there are few files
  const effectiveExpanded = useMemo(() => {
    if (search || filteredFiles.length <= 20) {
      const all = new Set<string>();
      const collectFolders = (nodes: TreeNode[]) => {
        for (const node of nodes) {
          if (node.isFolder) {
            all.add(node.path);
            collectFolders(node.children);
          }
        }
      };
      collectFolders(tree);
      return all;
    }
    return expandedFolders;
  }, [search, filteredFiles.length, tree, expandedFolders]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <Input
          data-testid="test-search"
          placeholder="Search tests..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
        <Button
          data-testid="test-run-all"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          disabled={isRunning || files.length === 0}
          onClick={onRunAll}
        >
          <Play className="h-3 w-3" />
          Run All
        </Button>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading tests...
          </div>
        ) : files.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No test files found
          </div>
        ) : filteredFiles.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No tests matching "{search}"
          </div>
        ) : (
          tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              depth={0}
              expandedFolders={effectiveExpanded}
              toggleFolder={toggleFolder}
              expandedFiles={expandedFiles}
              toggleFile={toggleFile}
              fileStatuses={fileStatuses}
              fileSpecs={fileSpecs}
              specsLoading={specsLoading}
              isRunning={isRunning}
              onRunFile={onRunFile}
              onRunSpec={onRunSpec}
              onExpandFile={onExpandFile}
            />
          ))
        )}
      </div>
    </div>
  );
}
