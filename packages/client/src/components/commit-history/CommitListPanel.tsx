import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUpCircle, ExternalLink, GitCommit, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { AuthorBadge } from '@/components/AuthorBadge';
import { EmptyState } from '@/components/ui/empty-state';
import { HighlightText } from '@/components/ui/highlight-text';
import { LoadingState } from '@/components/ui/loading-state';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { githubCommitUrlForRemoteCommit } from '@/lib/github-url';
import { shortRelativeDate } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

interface LogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  relativeDate: string;
  message: string;
  body: string;
}

interface Props {
  logEntries: LogEntry[];
  logLoading: boolean;
  hasMore: boolean;
  unpushedHashes: Set<string>;
  githubAvatarBySha: Map<string, string>;
  githubBrowseBaseUrl: string | null;
  selectedHash: string | null;
  onSelectHash: (hash: string | null) => void;
  onLoadMore: () => void;
}

// Keep SHA searches useful on paginated histories without pulling unbounded repo
// history into the client while the user types.
const FILTER_MAX_SCAN = 2000;

/**
 * Search bar + virtualized commit list. Owns its own commit search state and
 * the load-more sentinel logic. Extracted from CommitHistoryTab so the parent
 * doesn't import @tanstack/react-virtual, AuthorBadge, HighlightText,
 * SearchBar, shortRelativeDate, or the row-specific icons.
 */
export function CommitListPanel({
  logEntries,
  logLoading,
  hasMore,
  unpushedHashes,
  githubAvatarBySha,
  githubBrowseBaseUrl,
  selectedHash,
  onSelectHash,
  onLoadMore,
}: Props) {
  const { t } = useTranslation();
  const [commitSearch, setCommitSearch] = useState('');
  const [commitSearchCaseSensitive, setCommitSearchCaseSensitive] = useState(false);
  const isSearching = commitSearch.trim().length > 0;

  const filteredEntries = useMemo(() => {
    if (!isSearching) return logEntries;
    const matches = (e: LogEntry, q: string) =>
      e.message.includes(q) ||
      e.body.includes(q) ||
      e.author.includes(q) ||
      e.shortHash.includes(q) ||
      e.hash.includes(q);
    if (commitSearchCaseSensitive) return logEntries.filter((e) => matches(e, commitSearch));
    const q = commitSearch.toLowerCase();
    return logEntries.filter(
      (e) =>
        e.message.toLowerCase().includes(q) ||
        e.body.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q) ||
        e.shortHash.toLowerCase().includes(q) ||
        e.hash.toLowerCase().includes(q),
    );
  }, [logEntries, commitSearch, commitSearchCaseSensitive, isSearching]);

  const commitScrollRef = useRef<HTMLDivElement>(null);
  const showSentinel = hasMore && !isSearching;
  const rowCount = filteredEntries.length + (showSentinel ? 1 : 0);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => commitScrollRef.current,
    estimateSize: () => 48,
    getItemKey: (index) =>
      index >= filteredEntries.length ? '__sentinel__' : filteredEntries[index].hash,
    overscan: 10,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastItem = virtualItems[virtualItems.length - 1];
  const lastItemIndex = lastItem?.index;
  useEffect(() => {
    if (!showSentinel || lastItemIndex == null) return;
    if (lastItemIndex >= filteredEntries.length - 5) {
      onLoadMore();
    }
  }, [lastItemIndex, filteredEntries.length, showSentinel, onLoadMore]);

  // Searches can match commits beyond the currently loaded page, especially
  // when the user pastes a SHA. Page ahead in the background while filtered.
  useEffect(() => {
    if (!isSearching || !hasMore || logLoading) return;
    if (logEntries.length >= FILTER_MAX_SCAN) return;
    onLoadMore();
  }, [isSearching, hasMore, logLoading, logEntries.length, onLoadMore]);

  return (
    <>
      {logEntries.length > 0 && (
        <div className="border-sidebar-border bg-background border-b px-2 py-1">
          <SearchBar
            query={commitSearch}
            onQueryChange={setCommitSearch}
            placeholder={t('history.searchCommits', 'Filter commits…')}
            totalMatches={filteredEntries.length}
            resultLabel={commitSearch ? `${filteredEntries.length}/${logEntries.length}` : ''}
            caseSensitive={commitSearchCaseSensitive}
            onCaseSensitiveChange={setCommitSearchCaseSensitive}
            onClose={commitSearch ? () => setCommitSearch('') : undefined}
            autoFocus={false}
            testIdPrefix="history-commit-search"
          />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col overflow-y-auto" ref={commitScrollRef}>
          {logLoading && logEntries.length === 0 ? (
            <LoadingState
              testId="history-commits-loading"
              label={t('review.loadingLog', 'Loading commits…')}
            />
          ) : logEntries.length === 0 ? (
            <EmptyState icon={GitCommit} title={t('review.noCommits', 'No commits yet')} />
          ) : filteredEntries.length === 0 ? (
            <EmptyState
              icon={Search}
              title={t('history.noMatchingCommits', 'No matching commits')}
            />
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                if (virtualRow.index >= filteredEntries.length) {
                  return (
                    <SentinelRow
                      key="__sentinel__"
                      logLoading={logLoading}
                      onLoadMore={onLoadMore}
                      measureRef={virtualizer.measureElement}
                      index={virtualRow.index}
                      transform={virtualRow.start}
                    />
                  );
                }
                const entry = filteredEntries[virtualRow.index];
                return (
                  <CommitRow
                    key={entry.hash}
                    entry={entry}
                    selected={selectedHash === entry.hash}
                    unpushed={unpushedHashes.has(entry.hash)}
                    avatarUrl={githubAvatarBySha.get(entry.hash)}
                    githubBrowseBaseUrl={githubBrowseBaseUrl}
                    commitSearch={commitSearch}
                    measureRef={virtualizer.measureElement}
                    index={virtualRow.index}
                    transform={virtualRow.start}
                    onClick={() => onSelectHash(selectedHash === entry.hash ? null : entry.hash)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function SentinelRow({
  logLoading,
  onLoadMore,
  measureRef,
  index,
  transform,
}: {
  logLoading: boolean;
  onLoadMore: () => void;
  measureRef: (el: Element | null) => void;
  index: number;
  transform: number;
}) {
  const { t } = useTranslation();
  return (
    <div
      ref={measureRef}
      data-index={index}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${transform}px)`,
      }}
      className="flex items-center justify-center py-2"
    >
      {logLoading ? (
        <LoadingState
          fill={false}
          layout="inline"
          size="compact"
          testId="history-loading-more"
          label={t('history.loadingMore', 'Loading more…')}
        />
      ) : (
        <button
          type="button"
          onClick={onLoadMore}
          className="text-primary text-xs hover:underline"
          data-testid="history-load-more"
        >
          {t('history.loadMore', 'Load more commits')}
        </button>
      )}
    </div>
  );
}

function CommitRow({
  entry,
  selected,
  unpushed,
  avatarUrl,
  githubBrowseBaseUrl,
  commitSearch,
  measureRef,
  index,
  transform,
  onClick,
}: {
  entry: LogEntry;
  selected: boolean;
  unpushed: boolean;
  avatarUrl: string | undefined;
  githubBrowseBaseUrl: string | null;
  commitSearch: string;
  measureRef: (el: Element | null) => void;
  index: number;
  transform: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const githubUrl = githubCommitUrlForRemoteCommit(githubBrowseBaseUrl, entry.hash, unpushed);

  return (
    <div
      ref={measureRef}
      data-index={index}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${transform}px)`,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'w-full overflow-hidden border-b border-border px-3 py-2 text-left text-xs transition-colors',
          selected ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-accent/50',
        )}
        data-testid={`history-commit-${entry.shortHash}`}
      >
        <HighlightText
          text={entry.message}
          query={commitSearch}
          className="text-foreground block truncate font-medium"
        />
        <div className="text-muted-foreground mt-0.5 flex w-full min-w-0 items-center gap-1.5 text-[10px]">
          <AuthorBadge
            name={entry.author}
            email={entry.authorEmail}
            avatarUrl={avatarUrl}
            size="xs"
          >
            <HighlightText text={entry.author} query={commitSearch} />
          </AuthorBadge>
          <span className="text-muted-foreground shrink-0">
            {shortRelativeDate(entry.relativeDate)}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {unpushed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <ArrowUpCircle
                    className="icon-xs text-muted-foreground shrink-0"
                    data-testid={`history-unpushed-${entry.shortHash}`}
                  />
                </TooltipTrigger>
                <TooltipContent side="top">{t('history.unpushed', 'Not pushed')}</TooltipContent>
              </Tooltip>
            )}
            <GitCommit className="icon-xs shrink-0" />
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard.writeText(entry.hash).then(
                      () =>
                        toast.success(
                          t('history.hashCopied', {
                            hash: entry.shortHash,
                            defaultValue: `Copied ${entry.shortHash}`,
                          }),
                        ),
                      () => toast.error(t('history.hashCopyFailed', 'Failed to copy hash')),
                    );
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      (e.currentTarget as HTMLSpanElement).click();
                    }
                  }}
                  className="text-primary shrink-0 cursor-pointer font-mono hover:underline"
                  data-testid={`history-commit-hash-${entry.shortHash}`}
                >
                  <HighlightText text={entry.shortHash} query={commitSearch} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t('history.copyHash', 'Click to copy hash')}
              </TooltipContent>
            </Tooltip>
          </span>
          {githubUrl ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-foreground ml-auto shrink-0 transition-colors"
                  data-testid={`history-commit-github-${entry.shortHash}`}
                >
                  <ExternalLink className="icon-xs" />
                </a>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t('history.viewOnGithub', 'View on GitHub')}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </button>
    </div>
  );
}
