import type { TestNetworkEntry } from '@funny/shared';
import { useMemo, useState } from 'react';

import { NetworkDetailPanel } from '@/components/test-runner/detail-tabs/NetworkDetailPanel';
import {
  DetailTooltip,
  formatDuration,
  formatSize,
  shortenUrl,
} from '@/components/test-runner/detail-tabs/shared';
import { EmptyState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { cn } from '@/lib/utils';

type NetworkFilter = 'All' | 'Fetch' | 'HTML' | 'JS' | 'CSS' | 'Font' | 'Image';
const NETWORK_FILTERS: NetworkFilter[] = ['All', 'Fetch', 'HTML', 'JS', 'CSS', 'Font', 'Image'];

/** Map CDP resource types to our filter categories */
function matchesNetworkFilter(entry: TestNetworkEntry, filter: NetworkFilter): boolean {
  if (filter === 'All') return true;
  const type = (entry.resourceType ?? '').toLowerCase();
  const mime = (entry.mimeType ?? '').toLowerCase();
  const url = entry.url.toLowerCase();
  switch (filter) {
    case 'Fetch':
      return type === 'fetch' || type === 'xhr' || type === 'xmlhttprequest';
    case 'HTML':
      return type === 'document' || mime.includes('html');
    case 'JS':
      return type === 'script' || mime.includes('javascript');
    case 'CSS':
      return type === 'stylesheet' || mime.includes('css');
    case 'Font':
      return type === 'font' || mime.includes('font') || /\.(woff2?|ttf|otf|eot)/.test(url);
    case 'Image':
      return type === 'image' || mime.includes('image');
    default:
      return true;
  }
}

export function NetworkTab({ entries }: { entries: TestNetworkEntry[] }) {
  const [filter, setFilter] = useState<NetworkFilter>('All');
  const [search, setSearch] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = entries;
    if (filter !== 'All') {
      result = result.filter((e) => matchesNetworkFilter(e, filter));
    }
    if (search) {
      if (searchCaseSensitive) {
        result = result.filter((e) => e.url.includes(search));
      } else {
        const q = search.toLowerCase();
        result = result.filter((e) => e.url.toLowerCase().includes(q));
      }
    }
    return result;
  }, [entries, filter, search, searchCaseSensitive]);

  const selectedEntry = useMemo(
    () => (selectedId ? (entries.find((e) => e.id === selectedId) ?? null) : null),
    [entries, selectedId],
  );

  return (
    <div className="flex h-full flex-col text-xs">
      {/* Filter toolbar */}
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <SearchBar
          query={search}
          onQueryChange={setSearch}
          placeholder="Filter network"
          totalMatches={filtered.length}
          resultLabel={search ? `${filtered.length}/${entries.length}` : ''}
          caseSensitive={searchCaseSensitive}
          onCaseSensitiveChange={setSearchCaseSensitive}
          onClose={search ? () => setSearch('') : undefined}
          autoFocus={false}
          testIdPrefix="network-filter"
          className="mr-2 w-72"
        />
        {NETWORK_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded px-2 py-0.5 text-xs transition-colors',
              filter === f
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            data-testid={`network-filter-${f.toLowerCase()}`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Split: request list + detail panel */}
      <div className="flex min-h-0 flex-1">
        {/* Request list */}
        <ScrollArea
          className={cn('min-h-0 border-r', selectedEntry ? 'w-[280px] shrink-0' : 'flex-1')}
        >
          {filtered.length === 0 ? (
            <EmptyState
              title={
                entries.length === 0
                  ? 'Network requests will appear here...'
                  : 'No matching requests'
              }
            />
          ) : selectedEntry ? (
            /* Compact name-only list when detail is open */
            <div className="font-mono">
              <div className="bg-muted/80 text-muted-foreground sticky top-0 border-b px-3 py-1 font-medium">
                Name
              </div>
              {filtered.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  onClick={() => setSelectedId(entry.id)}
                  className={cn(
                    'block w-full cursor-pointer truncate border-b border-border/20 px-3 py-1 text-left hover:bg-muted/30',
                    entry.id === selectedId && 'bg-primary/10 text-primary',
                    entry.failed && 'text-status-error',
                    entry.status && entry.status >= 400 && 'text-status-error',
                  )}
                  data-testid={`network-row-${entry.id}`}
                >
                  <DetailTooltip label={entry.url}>
                    <span className="block truncate">{getUrlName(entry.url)}</span>
                  </DetailTooltip>
                </button>
              ))}
            </div>
          ) : (
            /* Full table when no detail selected */
            <table className="w-full font-mono">
              <thead className="bg-muted/80 text-muted-foreground sticky top-0 text-left">
                <tr>
                  <th className="px-3 py-1 font-medium">Status</th>
                  <th className="px-3 py-1 font-medium">Method</th>
                  <th className="px-3 py-1 font-medium">URL</th>
                  <th className="px-3 py-1 font-medium">Type</th>
                  <th className="px-3 py-1 text-right font-medium">Size</th>
                  <th className="px-3 py-1 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => (
                  <tr
                    key={entry.id}
                    onClick={() => setSelectedId(entry.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedId(entry.id);
                      }
                    }}
                    tabIndex={0}
                    className={cn(
                      'cursor-pointer border-b border-border/20 hover:bg-muted/30',
                      entry.failed && 'text-status-error',
                      entry.status && entry.status >= 400 && 'text-status-error',
                    )}
                    data-testid={`network-row-${entry.id}`}
                  >
                    <td className="px-3 py-1">
                      <StatusBadge
                        status={entry.status}
                        failed={entry.failed}
                        errorText={entry.errorText}
                      />
                    </td>
                    <td className="text-muted-foreground px-3 py-1">{entry.method}</td>
                    <td className="max-w-[300px] px-3 py-1">
                      <DetailTooltip label={entry.url}>
                        <span className="block truncate">{shortenUrl(entry.url)}</span>
                      </DetailTooltip>
                    </td>
                    <td className="text-muted-foreground px-3 py-1">{entry.resourceType ?? '-'}</td>
                    <td className="text-muted-foreground px-3 py-1 text-right">
                      {formatSize(entry.size)}
                    </td>
                    <td className="text-muted-foreground px-3 py-1 text-right">
                      {formatDuration(entry.duration)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ScrollArea>

        {/* Detail panel */}
        {selectedEntry && (
          <NetworkDetailPanel entry={selectedEntry} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </div>
  );
}

function getUrlName(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || u.hostname;
  } catch {
    return url.split('/').pop() || url;
  }
}

function StatusBadge({
  status,
  failed,
  errorText,
}: {
  status?: number;
  failed?: boolean;
  errorText?: string;
}) {
  if (failed && errorText) {
    return (
      <DetailTooltip label={errorText}>
        <span>ERR</span>
      </DetailTooltip>
    );
  }
  if (failed) return <span>ERR</span>;
  if (!status) return <span className="text-muted-foreground">...</span>;
  return (
    <span
      className={cn(
        status >= 200 && status < 300 && 'text-status-success',
        status >= 300 && status < 400 && 'text-status-warning',
        status >= 400 && 'text-status-error',
      )}
    >
      {status}
    </span>
  );
}
