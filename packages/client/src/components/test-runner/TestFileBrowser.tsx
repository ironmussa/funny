import type { TestFile, TestFileStatus, TestSpec, TestSuite } from '@funny/shared';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Play,
  Square,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
  MoreHorizontal,
  ExternalLink,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { openFileInExternalEditor, getEditorLabel } from '@/lib/editor-utils';
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
      return <Loader2 className="icon-xs animate-spin text-blue-500" />;
    case 'passed':
      return <CheckCircle2 className="icon-xs text-green-500" />;
    case 'failed':
      return <XCircle className="icon-xs text-red-500" />;
    case 'stopped':
      return <Circle className="icon-xs text-yellow-500" />;
    default:
      return <Circle className="icon-xs text-muted-foreground/30" />;
  }
}

/* ─── Individual spec (test) row ────────────────────────── */

function SpecItem({
  spec,
  depth,
  isRunning,
  showProjects,
  fileStatus,
  onRunSpec,
  onStop,
}: {
  spec: TestSpec;
  depth: number;
  isRunning: boolean;
  showProjects: boolean;
  fileStatus?: TestFileStatus;
  onRunSpec: (file: string, line: number, project?: string) => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasMultipleProjects = showProjects && spec.projects.length > 1;

  return (
    <>
      <div
        data-testid={`test-spec-${spec.file}-${spec.line}`}
        className="group flex h-6 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/50"
        style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
        onClick={hasMultipleProjects ? () => setExpanded(!expanded) : undefined}
      >
        {hasMultipleProjects ? (
          <ChevronRight
            className={cn('icon-sm flex-shrink-0 transition-transform', expanded && 'rotate-90')}
          />
        ) : (
          <StatusDot status={fileStatus} />
        )}
        <span className="flex-1 truncate font-mono-explorer text-xs" title={spec.title}>
          {spec.title}
        </span>
        {!hasMultipleProjects &&
          (isRunning && fileStatus === 'running' ? (
            <TooltipIconButton
              data-testid={`test-spec-stop-${spec.file}-${spec.line}`}
              size="icon"
              className="h-5 w-5 text-destructive opacity-100 hover:text-destructive"
              onClick={onStop}
              tooltip={t('common.stop')}
            >
              <Square className="icon-2xs fill-current" />
            </TooltipIconButton>
          ) : (
            <TooltipIconButton
              data-testid={`test-spec-play-${spec.file}-${spec.line}`}
              size="icon"
              className="h-5 w-5 opacity-0 group-hover:opacity-100"
              disabled={isRunning}
              onClick={() => onRunSpec(spec.file, spec.line)}
              tooltip={t('common.run')}
            >
              <Play className="icon-2xs" />
            </TooltipIconButton>
          ))}
      </div>
      {hasMultipleProjects &&
        expanded &&
        spec.projects.map((project) => (
          <div
            key={project}
            data-testid={`test-spec-${spec.file}-${spec.line}-${project}`}
            className="group flex h-6 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/50"
            style={{ paddingLeft: `${8 + (depth + 1) * INDENT_PX}px` }}
          >
            <StatusDot status={fileStatus} />
            <span className="flex-1 truncate font-mono-explorer text-xs">{project}</span>
            <TooltipIconButton
              data-testid={`test-spec-play-${spec.file}-${spec.line}-${project}`}
              size="icon"
              className="h-5 w-5 opacity-0 group-hover:opacity-100"
              disabled={isRunning}
              onClick={() => onRunSpec(spec.file, spec.line, project)}
              tooltip={`${t('common.run')} (${project})`}
            >
              <Play className="icon-2xs" />
            </TooltipIconButton>
          </div>
        ))}
    </>
  );
}

/* ─── Suite item (describe block) ──────────────────────── */

function SuiteItem({
  suite,
  depth,
  isRunning,
  showProjects,
  fileStatus,
  onRunSpec,
  onStop,
  expandedSuites,
  toggleSuite,
}: {
  suite: TestSuite;
  depth: number;
  isRunning: boolean;
  showProjects: boolean;
  fileStatus?: TestFileStatus;
  onRunSpec: (file: string, line: number, project?: string) => void;
  onStop: () => void;
  expandedSuites: Set<string>;
  toggleSuite: (key: string) => void;
}) {
  const suiteKey = `${suite.file}:${suite.line}`;
  const isExpanded = expandedSuites.has(suiteKey);

  // Untitled suite (top-level specs outside describe) — render specs directly
  if (!suite.title) {
    return (
      <>
        {suite.specs.map((spec) => (
          <SpecItem
            key={`${spec.file}:${spec.line}`}
            spec={spec}
            depth={depth}
            isRunning={isRunning}
            showProjects={showProjects}
            fileStatus={fileStatus}
            onRunSpec={onRunSpec}
            onStop={onStop}
          />
        ))}
      </>
    );
  }

  return (
    <>
      <div
        data-testid={`test-suite-${suite.file}-${suite.line}`}
        className={cn(
          'flex h-6 cursor-pointer select-none items-center gap-1.5 text-xs',
          'text-muted-foreground transition-colors hover:bg-sidebar-accent/50',
        )}
        style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
        onClick={() => toggleSuite(suiteKey)}
      >
        <ChevronRight
          className={cn('icon-sm flex-shrink-0 transition-transform', isExpanded && 'rotate-90')}
        />
        <StatusDot status={fileStatus} />
        <span
          className="flex-1 truncate font-mono-explorer text-xs font-medium"
          title={suite.title}
        >
          {suite.title}
        </span>
      </div>
      {isExpanded && (
        <>
          {suite.specs.map((spec) => (
            <SpecItem
              key={`${spec.file}:${spec.line}`}
              spec={spec}
              depth={depth + 1}
              isRunning={isRunning}
              showProjects={showProjects}
              fileStatus={fileStatus}
              onRunSpec={onRunSpec}
              onStop={onStop}
            />
          ))}
          {suite.suites.map((child) => (
            <SuiteItem
              key={`${child.file}:${child.line}`}
              suite={child}
              depth={depth + 1}
              isRunning={isRunning}
              showProjects={showProjects}
              fileStatus={fileStatus}
              onRunSpec={onRunSpec}
              onStop={onStop}
              expandedSuites={expandedSuites}
              toggleSuite={toggleSuite}
            />
          ))}
        </>
      )}
    </>
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
  expandedSuites: Set<string>;
  toggleSuite: (key: string) => void;
  fileStatuses: Record<string, TestFileStatus>;
  fileSpecs: Record<string, TestSpec[]>;
  fileSuites: Record<string, TestSuite[]>;
  specsLoading: Record<string, boolean>;
  isRunning: boolean;
  showProjects: boolean;
  projectPath?: string;
  onRunFile: (file: string) => void;
  onRunSpec: (file: string, line: number, project?: string) => void;
  onExpandFile: (file: string) => void;
  onStop: () => void;
}

function TreeItem({
  node,
  depth,
  expandedFolders,
  toggleFolder,
  expandedFiles,
  toggleFile,
  expandedSuites,
  toggleSuite,
  fileStatuses,
  fileSpecs,
  fileSuites,
  specsLoading,
  isRunning,
  showProjects,
  projectPath,
  onRunFile,
  onRunSpec,
  onExpandFile,
  onStop,
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
            className={cn('icon-sm flex-shrink-0 transition-transform', isExpanded && 'rotate-90')}
          />
          {isExpanded ? (
            <FolderOpen className="icon-base flex-shrink-0 text-muted-foreground/70" />
          ) : (
            <Folder className="icon-base flex-shrink-0 text-muted-foreground/70" />
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
              expandedSuites={expandedSuites}
              toggleSuite={toggleSuite}
              fileStatuses={fileStatuses}
              fileSpecs={fileSpecs}
              fileSuites={fileSuites}
              specsLoading={specsLoading}
              isRunning={isRunning}
              showProjects={showProjects}
              projectPath={projectPath}
              onRunFile={onRunFile}
              onRunSpec={onRunSpec}
              onExpandFile={onExpandFile}
              onStop={onStop}
            />
          ))}
      </>
    );
  }

  // File node — expandable to show individual specs
  const { t } = useTranslation();
  const status = fileStatuses[node.path];
  const isFileExpanded = expandedFiles.has(node.path);
  const specs = fileSpecs[node.path];
  const suites = fileSuites[node.path];
  const isSpecsLoading = specsLoading[node.path];
  const [menuOpen, setMenuOpen] = useState(false);

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
              'icon-sm flex-shrink-0 transition-transform text-muted-foreground',
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
        {status === 'running' ? (
          <Button
            data-testid={`test-stop-${node.path}`}
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-destructive opacity-100 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
          >
            <Square className="icon-xs fill-current" />
          </Button>
        ) : (
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
            <Play className="icon-xs" />
          </Button>
        )}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              data-testid={`test-file-menu-${node.path}`}
              className={cn(
                'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm hover:bg-sidebar-accent',
                menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="icon-sm" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem
              data-testid={`test-file-open-editor-${node.path}`}
              onClick={(e) => {
                e.stopPropagation();
                const fullPath = projectPath ? `${projectPath}/${node.path}` : node.path;
                openFileInExternalEditor(fullPath);
              }}
            >
              <ExternalLink />
              {t('review.openInEditor', { editor: getEditorLabel() })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Expanded specs / suites */}
      {isFileExpanded &&
        (isSpecsLoading ? (
          <div
            className="flex h-6 items-center gap-2 text-xs text-muted-foreground"
            style={{ paddingLeft: `${8 + (depth + 1) * INDENT_PX}px` }}
          >
            <Loader2 className="icon-xs animate-spin" />
            Discovering tests...
          </div>
        ) : suites && suites.length > 0 ? (
          suites.map((suite) => (
            <SuiteItem
              key={`${suite.file}:${suite.line}:${suite.title}`}
              suite={suite}
              depth={depth + 1}
              isRunning={isRunning}
              showProjects={showProjects}
              fileStatus={status}
              onRunSpec={onRunSpec}
              onStop={onStop}
              expandedSuites={expandedSuites}
              toggleSuite={toggleSuite}
            />
          ))
        ) : specs && specs.length > 0 ? (
          specs.map((spec) => (
            <SpecItem
              key={`${spec.file}:${spec.line}`}
              spec={spec}
              depth={depth + 1}
              isRunning={isRunning}
              showProjects={showProjects}
              fileStatus={status}
              onRunSpec={onRunSpec}
              onStop={onStop}
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
  fileSuites: Record<string, TestSuite[]>;
  specsLoading: Record<string, boolean>;
  isRunning: boolean;
  isLoading: boolean;
  projectPath?: string;
  availableProjects: string[];
  selectedProjects: string[];
  onToggleProject: (project: string) => void;
  onRunFile: (file: string) => void;
  onRunSpec: (file: string, line: number, project?: string) => void;
  onExpandFile: (file: string) => void;
  onRunAll: () => void;
  onStop: () => void;
}

export function TestFileBrowser({
  files,
  fileStatuses,
  fileSpecs,
  fileSuites,
  specsLoading,
  isRunning,
  isLoading,
  projectPath,
  availableProjects,
  selectedProjects,
  onToggleProject,
  onRunFile,
  onRunSpec,
  onExpandFile,
  onRunAll,
  onStop,
}: TestFileBrowserProps) {
  const [search, setSearch] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [expandedSuites, setExpandedSuites] = useState<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const filteredFiles = useMemo(() => {
    if (!search) return files;
    if (searchCaseSensitive) {
      return files.filter((f) => f.path.includes(search));
    }
    const lower = search.toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(lower));
  }, [files, search, searchCaseSensitive]);

  const tree = useMemo(() => buildTree(filteredFiles), [filteredFiles]);

  // Always expand root-level folders; auto-expand all folders when there are few files
  useEffect(() => {
    if (files.length === 0) return;

    if (!initializedRef.current) {
      initializedRef.current = true;
      const all = new Set<string>();
      if (files.length <= 20) {
        const collectFolders = (nodes: TreeNode[]) => {
          for (const node of nodes) {
            if (node.isFolder) {
              all.add(node.path);
              collectFolders(node.children);
            }
          }
        };
        collectFolders(tree);
      } else {
        // Always expand root-level folders
        for (const node of tree) {
          if (node.isFolder) all.add(node.path);
        }
      }
      setExpandedFolders(all);
    } else {
      // Ensure root folders stay expanded even after re-renders
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const node of tree) {
          if (node.isFolder && !next.has(node.path)) {
            next.add(node.path);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [files.length, tree]);

  // Force-expand all folders when actively searching
  const effectiveExpanded = useMemo(() => {
    if (search) {
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
  }, [search, tree, expandedFolders]);

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

  const toggleSuite = (key: string) => {
    setExpandedSuites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <SearchBar
          query={search}
          onQueryChange={setSearch}
          placeholder="Search tests..."
          totalMatches={filteredFiles.length}
          resultLabel={search ? `${filteredFiles.length}/${files.length}` : ''}
          caseSensitive={searchCaseSensitive}
          onCaseSensitiveChange={setSearchCaseSensitive}
          onClose={search ? () => setSearch('') : undefined}
          autoFocus={false}
          testIdPrefix="test-search"
          className="flex-1"
        />
        {isRunning ? (
          <Button
            data-testid="test-stop"
            variant="destructive"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            onClick={onStop}
          >
            <Square className="icon-sm" />
            Stop
          </Button>
        ) : (
          <Button
            data-testid="test-run-all"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            disabled={files.length === 0}
            onClick={onRunAll}
          >
            <Play className="icon-sm" />
            Run All
          </Button>
        )}
      </div>

      {/* Browser project selector */}
      {availableProjects.length > 1 && (
        <div className="flex items-center gap-3 border-b px-3 py-1.5">
          <span className="text-xs text-muted-foreground">Projects:</span>
          {availableProjects.map((project) => (
            <label
              key={project}
              data-testid={`test-project-${project}`}
              className="flex cursor-pointer items-center gap-1.5"
            >
              <Checkbox
                checked={selectedProjects.includes(project)}
                onCheckedChange={() => onToggleProject(project)}
              />
              <span className="text-xs text-muted-foreground">{project}</span>
            </label>
          ))}
        </div>
      )}

      {/* File tree */}
      <ScrollArea className="flex-1 pr-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="icon-base mr-2 animate-spin" />
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
              expandedSuites={expandedSuites}
              toggleSuite={toggleSuite}
              fileStatuses={fileStatuses}
              fileSpecs={fileSpecs}
              fileSuites={fileSuites}
              specsLoading={specsLoading}
              isRunning={isRunning}
              showProjects={selectedProjects.length > 1}
              projectPath={projectPath}
              onRunFile={onRunFile}
              onRunSpec={onRunSpec}
              onExpandFile={onExpandFile}
              onStop={onStop}
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
