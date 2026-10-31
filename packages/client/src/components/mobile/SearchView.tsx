import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { normalize } from '@/components/ui/highlight-text';
import { SearchBar } from '@/components/ui/search-bar';
import { VirtualThreadList } from '@/components/VirtualThreadList';
import { useThreadContentSearch } from '@/hooks/use-thread-content-search';
import { useThreadsForProject } from '@/lib/thread-selectors';
import { useAppStore } from '@/stores/app-store';

interface Props {
  projectId: string;
  /** Controlled by MobilePage so the query survives navigating into a result and back. */
  query: string;
  onQueryChange: (q: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (v: boolean) => void;
  onBack: () => void;
  onSelectThread: (threadId: string) => void;
}

/**
 * Mobile counterpart of the desktop AllThreadsView search (`/list`), scoped to
 * a single project. Same functionality: text search across title / branch /
 * status plus server-side message-content search (with snippets + match
 * highlighting), case-sensitivity toggle, and live result count.
 */
export function SearchView({
  projectId,
  query: search,
  onQueryChange: setSearch,
  caseSensitive,
  onCaseSensitiveChange: setCaseSensitive,
  onBack,
  onSelectThread,
}: Props) {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const threads = useThreadsForProject(projectId);
  const project = projects.find((p) => p.id === projectId);

  const contentMatches = useThreadContentSearch(search, projectId, caseSensitive);

  const filtered = useMemo(() => {
    const result = threads.filter((th) => !th.archived);
    const q = search.trim();
    if (!q) return result;

    // Case-insensitive by default (also strips accents); case-sensitive uses a
    // raw substring match. Matches title, branch, status OR message content.
    const matches = caseSensitive
      ? (text: string | undefined | null) => !!text && text.includes(search)
      : (
          (needle) => (text: string | undefined | null) =>
            !!text && normalize(text).includes(needle)
        )(normalize(search));

    return result.filter(
      (th) =>
        matches(th.title) || matches(th.branch) || matches(th.status) || contentMatches.has(th.id),
    );
  }, [threads, search, caseSensitive, contentMatches]);

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <button
          onClick={onBack}
          aria-label={t('common.back', 'Back')}
          className="hover:bg-accent -ml-1 rounded p-1"
        >
          <ArrowLeft className="icon-lg" />
        </button>
        <div className="flex-1">
          <SearchBar
            query={search}
            onQueryChange={setSearch}
            totalMatches={filtered.length}
            caseSensitive={caseSensitive}
            onCaseSensitiveChange={setCaseSensitive}
            placeholder={t('allThreads.searchPlaceholder', {
              defaultValue: 'Search {{name}}…',
              name: project?.name ?? '',
            })}
            testIdPrefix="mobile-search"
          />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
        <VirtualThreadList
          threads={filtered}
          search={search}
          contentSnippets={contentMatches}
          emptyMessage={t('allThreads.noThreads', 'No threads yet.')}
          searchEmptyMessage={t('allThreads.noMatch', 'No threads match your search.')}
          hideBranch
          onThreadClick={(thread) => onSelectThread(thread.id)}
        />
      </div>
    </>
  );
}
