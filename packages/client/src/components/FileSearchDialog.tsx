import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { HighlightText } from '@/components/ui/highlight-text';
import { LoadingState } from '@/components/ui/loading-state';
import { useRankedFileSearch } from '@/hooks/use-ranked-file-search';
import { api } from '@/lib/api';
import type { RankedFileSearchMatch, RankedFileSearchTarget } from '@/lib/api/browse';
import { FileExtensionIcon } from '@/lib/file-icons';
import { isScratch } from '@/lib/thread-variant';
import { cn } from '@/lib/utils';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadCore, useThreadWorktreePath } from '@/stores/thread-context';

interface FileSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const RESULT_LIMIT = 200;
const ROW_HEIGHT_PX = 32;
const LIST_MAX_HEIGHT_PX = 360;
const EMPTY_MATCHES: RankedFileSearchMatch[] = [];

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

  const localBasePath = worktreePath || project?.path;

  const searchTarget = useMemo<RankedFileSearchTarget | null>(() => {
    if (scratch) return threadCore ? { threadId: threadCore.id } : null;
    return localBasePath ? { path: localBasePath } : null;
  }, [scratch, threadCore, localBasePath]);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const { response, searching, error } = useRankedFileSearch({
    enabled: open,
    target: searchTarget,
    query,
    limit: RESULT_LIMIT,
  });
  const matches = response?.matches ?? EMPTY_MATCHES;
  const basePath = response?.basePath ?? localBasePath;

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveIndex(0);
  }, [response]);

  const handleSelect = useCallback(
    (relativePath: string) => {
      if (!basePath) return;
      onOpenChange(false);
      const absolutePath = `${basePath}/${relativePath}`;
      void useInternalEditorStore.getState().openFile(absolutePath);
      if (searchTarget) {
        void api.trackFileSelection(searchTarget, query, relativePath);
      }
    },
    [onOpenChange, basePath, searchTarget, query],
  );

  // Compute filename + per-result highlight indices once per result set
  const items = useMemo(
    () =>
      matches.map((m) => {
        const slash = m.path.lastIndexOf('/');
        const filename = slash === -1 ? m.path : m.path.slice(slash + 1);
        const filenameStart = slash + 1;
        const filenameIndices = m.indices.every((index) => index >= filenameStart)
          ? m.indices.map((index) => index - filenameStart)
          : [];
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

  const hasTarget = !!searchTarget;
  const showLoading = hasTarget && searching && items.length === 0;
  const showEmpty = hasTarget && !searching && !error && items.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="bg-card data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in fixed top-[20%] left-[50%] z-50 w-full max-w-3xl translate-x-[-50%] overflow-hidden rounded-lg border p-0 shadow-xl"
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
            ) : error ? (
              <EmptyRow text={error} />
            ) : showLoading ? (
              <LoadingRow text={t('fileSearch.searching', 'Searching files...')} />
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
                      tabIndex={isActive ? 0 : -1}
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
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleSelect(item.match.path);
                        }
                      }}
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
                      <HighlightText
                        text={item.match.path}
                        query={query}
                        indices={item.match.indices}
                        className="text-muted-foreground ml-auto truncate text-xs"
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
            {response?.truncated && items.length > 0 && (
              <div className="text-muted-foreground border-t px-3 py-1.5 text-center text-xs">
                {t('fileSearch.truncated', 'Showing first {{count}} results — refine your search', {
                  count: matches.length,
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
