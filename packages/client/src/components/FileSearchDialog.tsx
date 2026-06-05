import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { HighlightText } from '@/components/ui/highlight-text';
import { LoadingState } from '@/components/ui/loading-state';
import { createClientLogger } from '@/lib/client-logger';
import { FileExtensionIcon } from '@/lib/file-icons';
import { FileSearchWorkerClient, type FileSearchMatch } from '@/lib/file-search-worker-client';
import { isScratch } from '@/lib/thread-variant';
import { cn } from '@/lib/utils';
import { useFileIndexStore, type FileIndexTarget } from '@/stores/file-index-store';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadCore, useThreadWorktreePath } from '@/stores/thread-context';

const log = createClientLogger('file-search-dialog');

interface FileSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const RESULT_LIMIT = 200;
const ROW_HEIGHT_PX = 32;
const LIST_MAX_HEIGHT_PX = 360;

export function FileSearchDialog({ open, onOpenChange }: FileSearchDialogProps) {
  if (!open) {
    return null;
  }

  return <FileSearchDialogContent open={open} onOpenChange={onOpenChange} />;
}

function FileSearchDialogContent({ open, onOpenChange }: FileSearchDialogProps) {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === selectedProjectId);
  const worktreePath = useThreadWorktreePath();
  const threadCore = useThreadCore();
  const scratch = isScratch(threadCore);

  // Scratch threads have no project/worktree path the client can compute —
  // we ask the server to resolve the cwd by threadId and echo it back as
  // `resolvedBasePath`. Non-scratch threads keep using the local path.
  const [resolvedBasePath, setResolvedBasePath] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const localBasePath = worktreePath || project?.path;
  const basePath = scratch ? resolvedBasePath : localBasePath;

  const indexTarget = useMemo<FileIndexTarget | null>(() => {
    if (scratch) return threadCore ? { threadId: threadCore.id } : null;
    return localBasePath ? { path: localBasePath } : null;
  }, [scratch, threadCore, localBasePath]);

  const ensureIndex = useFileIndexStore((s) => s.ensureIndex);
  const indexEntry = useFileIndexStore((s) => (basePath ? s.byPath[basePath] : undefined));

  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<FileSearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const workerRef = useRef<FileSearchWorkerClient | null>(null);

  const getWorker = useCallback(() => {
    if (!workerRef.current && typeof window !== 'undefined') {
      workerRef.current = new FileSearchWorkerClient();
      if (basePath && indexEntry) {
        workerRef.current.setIndex(`${basePath}:${indexEntry.version}`, indexEntry.files);
      }
    }
    return workerRef.current;
  }, [basePath, indexEntry]);

  useEffect(() => {
    return () => {
      workerRef.current?.dispose();
      workerRef.current = null;
    };
  }, []);

  // Hydrate the index when the dialog opens (or target changes). For scratch
  // threads the server resolves the cwd by threadId and returns it as
  // `basePath`; we stash it locally so `handleSelect` can build absolute paths.
  useEffect(() => {
    if (!open || !indexTarget) return;
    setLoadError(null);
    ensureIndex(indexTarget)
      .then((result) => {
        if (scratch && result.basePath) {
          setResolvedBasePath(result.basePath);
        }
        // Resolved but no usable index — surface as an error so the dialog
        // doesn't sit spinning forever (e.g. 404 / 502 from the runner).
        if (!result.entry && !result.basePath) {
          setLoadError('Could not load file index');
        }
      })
      .catch((err) => {
        log.warn('failed to load file index', { target: indexTarget, error: String(err) });
        setLoadError(String(err?.message ?? err));
      });
  }, [open, indexTarget, scratch, ensureIndex]);

  // Push the index into the worker whenever it changes
  useEffect(() => {
    if (!basePath || !indexEntry) return;
    const w = getWorker();
    if (w) w.setIndex(`${basePath}:${indexEntry.version}`, indexEntry.files);
  }, [basePath, indexEntry, getWorker]);

  const runSearch = useCallback(
    async (q: string) => {
      const w = getWorker();
      if (!w || !indexEntry) {
        setMatches([]);
        setTruncated(false);
        return;
      }
      setSearching(true);
      const result = await w.search(q, RESULT_LIMIT);
      setMatches(result.matches);
      setTruncated(result.truncated);
      setSearching(false);
      setActiveIndex(0);
    },
    [indexEntry],
  );

  useEffect(() => {
    if (!open) return;
    runSearch(query);
  }, [query, open, runSearch]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery('');
      setMatches([]);
      setTruncated(false);
      setActiveIndex(0);
      setLoadError(null);
    }
  }, [open]);

  const handleSelect = useCallback(
    (relativePath: string) => {
      if (!basePath) return;
      onOpenChange(false);
      const absolutePath = `${basePath}/${relativePath}`;
      useInternalEditorStore.getState().openFile(absolutePath);
    },
    [onOpenChange, basePath],
  );

  // Compute filename + per-result highlight indices once per result set
  const items = useMemo(
    () =>
      matches.map((m) => {
        const slash = m.path.lastIndexOf('/');
        const filename = slash === -1 ? m.path : m.path.slice(slash + 1);
        const filenameStart = slash + 1;
        const filenameIndices = m.indices
          .filter((i) => i >= filenameStart)
          .map((i) => i - filenameStart);
        return { match: m, filename, filenameIndices };
      }),
    [matches],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    getItemKey: (i) => items[i]?.match.path ?? i,
    overscan: 8,
  });

  // Keep active row in view during keyboard navigation
  useEffect(() => {
    if (items.length === 0) return;
    virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
  }, [activeIndex, items.length, virtualizer]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (items.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % items.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + items.length) % items.length);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActiveIndex(items.length - 1);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 10, items.length - 1));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 10, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[activeIndex];
        if (item) handleSelect(item.match.path);
      }
    },
    [items, activeIndex, handleSelect],
  );

  // Scratch threads wait for the server to resolve their cwd, so we show
  // "indexing" while the resolve+fetch is in flight even before basePath
  // is known locally.
  const hasTarget = !!indexTarget;
  const isLoadingIndex = hasTarget && !loadError && (!basePath || !indexEntry);
  const showEmpty = hasTarget && !isLoadingIndex && !loadError && !searching && items.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="bg-card data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in fixed top-[20%] left-[50%] z-50 w-full max-w-lg translate-x-[-50%] overflow-hidden rounded-lg border p-0 shadow-xl"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">{t('fileSearch.title', 'Search files')}</DialogTitle>

          <div className="flex h-12 items-center border-b px-3">
            <Search className="mr-2 size-5 shrink-0 opacity-50" />
            <input
              ref={inputRef}
              data-testid="file-search-input"
              placeholder={t('fileSearch.placeholder', 'Search files by name...')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="placeholder:text-muted-foreground flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          <div
            ref={scrollRef}
            className="overflow-y-auto"
            style={{ maxHeight: LIST_MAX_HEIGHT_PX }}
          >
            {!hasTarget ? (
              <EmptyRow text={t('fileSearch.noProject', 'Select a project first')} />
            ) : loadError ? (
              <EmptyRow text={t('fileSearch.loadError', 'Could not load file index')} />
            ) : isLoadingIndex ? (
              <LoadingRow text={t('fileSearch.indexing', 'Indexing files...')} />
            ) : showEmpty ? (
              <EmptyRow text={t('fileSearch.noResults', 'No files found')} />
            ) : items.length > 0 ? (
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((vRow) => {
                  const item = items[vRow.index];
                  if (!item) return null;
                  const isActive = vRow.index === activeIndex;
                  return (
                    <div
                      key={vRow.key}
                      data-testid={`file-search-item-${item.match.path}`}
                      role="option"
                      aria-selected={isActive}
                      className={cn(
                        'absolute left-0 top-0 flex w-full cursor-pointer items-center gap-2 px-3',
                        isActive && 'bg-accent text-accent-foreground',
                      )}
                      style={{
                        height: vRow.size,
                        transform: `translateY(${vRow.start}px)`,
                      }}
                      onMouseEnter={() => setActiveIndex(vRow.index)}
                      onClick={() => handleSelect(item.match.path)}
                    >
                      <FileExtensionIcon
                        filePath={item.match.path}
                        className="icon-base shrink-0"
                      />
                      <HighlightText
                        text={item.filename}
                        query={query}
                        indices={item.filenameIndices}
                        className="truncate text-xs"
                      />
                      <span className="text-muted-foreground ml-auto truncate text-xs">
                        {item.match.path}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {truncated && items.length > 0 && (
              <div className="text-muted-foreground border-t px-3 py-1.5 text-center text-xs">
                {t('fileSearch.truncated', 'Showing first {{count}} results — refine your search', {
                  count: RESULT_LIMIT,
                })}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="text-muted-foreground px-3 py-6 text-center text-sm">{text}</div>;
}

function LoadingRow({ text }: { text: string }) {
  return (
    <LoadingState
      fill={false}
      layout="inline"
      size="compact"
      className="px-3 py-6"
      testId="file-search-loading"
      label={text}
    />
  );
}
