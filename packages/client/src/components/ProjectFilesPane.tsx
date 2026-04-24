import type { FileDiffSummary } from '@funny/shared';
import {
  FolderMinus,
  FolderOpen,
  FolderTree,
  Loader2,
  PanelRightClose,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { collectAllFolderPaths, FileTree } from '@/components/FileTree';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('project-files-pane');

const MAX_FILES = 10000;
const COLLAPSED_STORAGE_PREFIX = 'project-files-collapsed:';

function collapsedStorageKey(basePath: string | undefined): string | null {
  return basePath ? `${COLLAPSED_STORAGE_PREFIX}${basePath}` : null;
}

function loadCollapsed(basePath: string | undefined): Set<string> | null {
  const key = collapsedStorageKey(basePath);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
      return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {}
  return null;
}

function saveCollapsed(basePath: string | undefined, set: Set<string>): void {
  const key = collapsedStorageKey(basePath);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {}
}

export function ProjectFilesPane() {
  const { t } = useTranslation();
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === selectedProjectId);
  const activeThreadWorktreePath = useThreadStore((s) => s.activeThread?.worktreePath);

  const basePath = activeThreadWorktreePath || project?.path;

  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const requestIdRef = useRef(0);
  const collapsedInitializedRef = useRef<string | null>(null);

  const loadFiles = useCallback(() => {
    if (!basePath) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);

    api.browseFiles(basePath, undefined, MAX_FILES).then((result) => {
      if (requestId !== requestIdRef.current) return;
      if (result.isOk()) {
        const normalized = result.value.files.map((f) => (typeof f === 'string' ? f : f.path));
        setFiles(normalized);
        setTruncated(result.value.truncated);
      } else {
        log.error('Failed to load project files', { error: String(result.error) });
        setFiles([]);
        setTruncated(false);
      }
      setLoading(false);
    });
  }, [basePath]);

  useEffect(() => {
    loadFiles();
    return () => {
      requestIdRef.current++;
    };
  }, [loadFiles]);

  useEffect(() => {
    collapsedInitializedRef.current = null;
    const saved = loadCollapsed(basePath);
    setCollapsedFolders(saved ?? new Set());
    if (saved) collapsedInitializedRef.current = basePath ?? null;
  }, [basePath]);

  const allSummaries = useMemo<FileDiffSummary[]>(
    () =>
      files.map((path) => ({
        path,
        status: 'modified',
        staged: false,
      })),
    [files],
  );

  useEffect(() => {
    if (collapsedInitializedRef.current === (basePath ?? null)) return;
    if (files.length === 0) return;
    const allFolders = collectAllFolderPaths(allSummaries);
    setCollapsedFolders(allFolders);
    saveCollapsed(basePath, allFolders);
    collapsedInitializedRef.current = basePath ?? null;
  }, [basePath, files, allSummaries]);

  const filteredSummaries = useMemo<FileDiffSummary[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allSummaries;
    return allSummaries.filter((s) => s.path.toLowerCase().includes(q));
  }, [allSummaries, query]);

  const handleCollapsedChange = useCallback(
    (next: Set<string>) => {
      setCollapsedFolders(next);
      saveCollapsed(basePath, next);
    },
    [basePath],
  );

  const handleCollapseAll = useCallback(() => {
    const all = collectAllFolderPaths(filteredSummaries);
    setCollapsedFolders(all);
    saveCollapsed(basePath, all);
  }, [filteredSummaries, basePath]);

  const handleExpandAll = useCallback(() => {
    const empty = new Set<string>();
    setCollapsedFolders(empty);
    saveCollapsed(basePath, empty);
  }, [basePath]);

  const handleFileClick = useCallback(
    (relativePath: string) => {
      if (!basePath) return;
      const absolutePath = `${basePath}/${relativePath}`;
      void useInternalEditorStore.getState().openFile(absolutePath);
    },
    [basePath],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-2">
        <div className="flex min-w-0 items-center gap-2 px-1 text-sm font-medium">
          <FolderTree className="icon-base flex-shrink-0 text-muted-foreground" />
          <span className="truncate">{t('projectFiles.title', 'Project Files')}</span>
          {project?.name && (
            <span className="truncate text-xs text-muted-foreground">· {project.name}</span>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setReviewPaneOpen(false)}
              data-testid="project-files-close"
              className="text-muted-foreground"
            >
              <PanelRightClose className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('review.close', 'Close')}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleCollapseAll}
              disabled={!basePath || files.length === 0}
              data-testid="project-files-collapse-all"
              className="text-muted-foreground"
            >
              <FolderMinus className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t('common.collapseAll', 'Collapse all folders')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleExpandAll}
              disabled={!basePath || files.length === 0}
              data-testid="project-files-expand-all"
              className="text-muted-foreground"
            >
              <FolderOpen className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t('common.expandAll', 'Expand all folders')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={loadFiles}
              disabled={loading || !basePath}
              data-testid="project-files-refresh"
              className="text-muted-foreground"
            >
              <RefreshCw className={loading ? 'icon-base animate-spin' : 'icon-base'} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex-shrink-0 border-b border-sidebar-border px-2 py-2">
        <div className="relative">
          <Search className="icon-sm pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            data-testid="project-files-filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('projectFiles.filterPlaceholder', 'Filter files\u2026')}
            aria-label={t('projectFiles.filterPlaceholder', 'Filter files')}
            className="h-7 pl-7 pr-7 text-xs md:text-xs"
          />
          {query && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setQuery('')}
              aria-label={t('review.clearSearch', 'Clear search')}
              data-testid="project-files-filter-clear"
              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              <X className="icon-xs" />
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {!basePath ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t('projectFiles.noProject', 'Select a project first')}
          </div>
        ) : loading && files.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="icon-sm animate-spin" />
            {t('projectFiles.loading', 'Loading files...')}
          </div>
        ) : filteredSummaries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {query
              ? t('projectFiles.noMatches', 'No files match your filter')
              : t('projectFiles.empty', 'No files in this project')}
          </div>
        ) : (
          <FileTree
            files={filteredSummaries}
            onFileClick={handleFileClick}
            basePath={basePath}
            virtualize
            hideStatus
            hideDiffStats
            searchQuery={query}
            testIdPrefix="project-files"
            collapsedFolders={collapsedFolders}
            onCollapsedFoldersChange={handleCollapsedChange}
          />
        )}
      </div>

      {truncated && (
        <div className="flex-shrink-0 border-t border-border px-3 py-1.5 text-center text-xs text-muted-foreground">
          {t('projectFiles.truncated', {
            limit: MAX_FILES,
            defaultValue: `Showing first ${MAX_FILES} files`,
          })}
        </div>
      )}
    </div>
  );
}
