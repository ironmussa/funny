import type { GitHubRepo } from '@funny/shared';
import { Globe, Lock, LogOut } from 'lucide-react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { HighlightText } from '@/components/ui/highlight-text';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { elapsedMinutesLabel } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

type GithubUser = { login: string; avatar_url: string; name: string | null };

interface RepoBrowserHeaderProps {
  ghUser: GithubUser;
  tokenSource: 'profile' | 'cli' | null;
  onDisconnect: () => void;
}

/** The connected GitHub account, with a disconnect button unless the token comes from gh. */
function RepoBrowserHeader({ ghUser, tokenSource, onDisconnect }: RepoBrowserHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex items-center gap-2">
      <img src={ghUser.avatar_url} alt={ghUser.login} className="size-6 rounded-full" />
      <span className="text-sm font-medium">{ghUser.login}</span>
      {tokenSource === 'cli' ? (
        <span className="text-muted-foreground ml-auto text-xs">
          {t('github.viaGhCli', { defaultValue: 'via gh CLI' })}
        </span>
      ) : (
        <Button
          variant="muted"
          size="xs"
          className="ml-auto"
          onClick={onDisconnect}
          data-testid="clone-repo-disconnect"
        >
          <LogOut className="icon-xs mr-1" />
          {t('github.disconnect')}
        </Button>
      )}
    </div>
  );
}

interface RepoListItemProps {
  repo: GitHubRepo;
  highlighted: boolean;
  query: string;
  now: number;
  onSelect: () => void;
  onHighlight: () => void;
}

/** One repository of the list: name, visibility, description, language and last update. */
function RepoListItem({ repo, highlighted, query, now, onSelect, onHighlight }: RepoListItemProps) {
  const { t } = useTranslation();
  const updatedMinutesAgo = Math.floor((now - new Date(repo.updated_at).getTime()) / 60000);
  return (
    <button
      data-repo-item
      data-testid={`clone-repo-item-${repo.id}`}
      onClick={onSelect}
      onMouseEnter={onHighlight}
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent',
        highlighted && 'bg-accent',
      )}
    >
      <div className="flex items-center gap-2">
        <HighlightText
          text={repo.full_name}
          query={query}
          className="truncate text-sm font-medium"
        />
        {repo.private ? (
          <Lock className="icon-xs text-status-pending shrink-0" />
        ) : (
          <Globe className="icon-xs text-muted-foreground shrink-0" />
        )}
      </div>
      {repo.description && (
        <HighlightText
          text={repo.description}
          query={query}
          className="text-muted-foreground truncate text-xs"
        />
      )}
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        {repo.language && <HighlightText text={repo.language} query={query} />}
        <span>{elapsedMinutesLabel(updatedMinutesAgo, t)}</span>
      </div>
    </button>
  );
}

interface RepoListProps {
  repos: GitHubRepo[];
  loadingRepos: boolean;
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (repo: GitHubRepo) => void;
  query: string;
  listRef: RefObject<HTMLDivElement | null>;
  sentinelRef: RefObject<HTMLDivElement | null>;
  now: number;
}

/** The scrolling repository list, with its loading and empty states and the infinite-scroll sentinel. */
function RepoList({
  repos,
  loadingRepos,
  highlightedIndex,
  onHighlight,
  onSelect,
  query,
  listRef,
  sentinelRef,
  now,
}: RepoListProps) {
  const { t } = useTranslation();
  return (
    <ScrollArea viewportRef={listRef} className="-mx-1 max-h-[40vh] min-h-0 flex-1">
      {repos.map((repo, index) => (
        <RepoListItem
          key={repo.id}
          repo={repo}
          highlighted={highlightedIndex === index}
          query={query}
          now={now}
          onSelect={() => onSelect(repo)}
          onHighlight={() => onHighlight(index)}
        />
      ))}

      {loadingRepos && (
        <LoadingState fill={false} className="py-4" testId="clone-repo-loading-repos" />
      )}

      {!loadingRepos && repos.length === 0 && (
        <EmptyState padding="md" fill={false} title={t('github.repos.noRepos')} />
      )}

      <div ref={sentinelRef} aria-hidden className="h-1 w-full" />
    </ScrollArea>
  );
}

interface RepoBrowserProps {
  ghUser: GithubUser | null;
  tokenSource: 'profile' | 'cli' | null;
  onDisconnect: () => void;
  search: string;
  onSearchChange: (query: string) => void;
  debouncedSearch: string;
  onSearchKeyDown: (e: React.KeyboardEvent) => void;
  repos: GitHubRepo[];
  loadingRepos: boolean;
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (repo: GitHubRepo) => void;
  listRef: RefObject<HTMLDivElement | null>;
  sentinelRef: RefObject<HTMLDivElement | null>;
  now: number;
}

/** The searchable, infinitely scrolling list of the user's GitHub repositories. */
export function RepoBrowser({
  ghUser,
  tokenSource,
  onDisconnect,
  search,
  onSearchChange,
  debouncedSearch,
  onSearchKeyDown,
  repos,
  loadingRepos,
  highlightedIndex,
  onHighlight,
  onSelect,
  listRef,
  sentinelRef,
  now,
}: RepoBrowserProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      {/* Header with user info */}
      {ghUser && (
        <RepoBrowserHeader ghUser={ghUser} tokenSource={tokenSource} onDisconnect={onDisconnect} />
      )}

      {/* Search */}
      <div className="mb-3">
        <SearchBar
          query={search}
          onQueryChange={onSearchChange}
          placeholder={t('github.repos.searchPlaceholder')}
          totalMatches={repos.length}
          resultLabel={search ? `${repos.length}` : ''}
          onClose={search ? () => onSearchChange('') : undefined}
          onInputKeyDown={onSearchKeyDown}
          autoFocus={false}
          testIdPrefix="clone-repo-search"
          className="border-input bg-background h-8 rounded-md border px-3 [&_input]:h-full [&_input]:px-0 [&_input]:text-sm"
        />
      </div>

      {/* Repo list */}
      <RepoList
        repos={repos}
        loadingRepos={loadingRepos}
        highlightedIndex={highlightedIndex}
        onHighlight={onHighlight}
        onSelect={onSelect}
        query={debouncedSearch}
        listRef={listRef}
        sentinelRef={sentinelRef}
        now={now}
      />
    </div>
  );
}
