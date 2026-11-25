import { useEffect, useMemo, useState } from 'react';

import { useProjects } from '@/data/projects/hooks';
import { useProjectStore } from '@/stores/project-store';
import { useThreadId } from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

type SearchTarget = { threadId: string } | { path: string };

interface SearchFlags {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
}

function targetFor(threadId: string | null, projectPath: string | null): SearchTarget | null {
  if (threadId) return { threadId };
  return projectPath ? { path: projectPath } : null;
}

function scopeKeyFor(threadId: string | null, projectPath: string | null): string {
  if (threadId) return `thread:${threadId}`;
  return projectPath ? `path:${projectPath}` : '';
}

/** Where to search: the open thread, else the selected project, else nowhere. */
export function useSearchTarget() {
  const threadId = useThreadId() ?? null;
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjects();
  const projectPath = projects.find((p) => p.id === selectedProjectId)?.path ?? null;
  const searchTarget = useMemo(() => targetFor(threadId, projectPath), [threadId, projectPath]);
  return { searchTarget, searchScopeKey: scopeKeyFor(threadId, projectPath) };
}

/** The request body for a trimmed, non-empty query. */
export function buildSearchRequest(target: SearchTarget, query: string, flags: SearchFlags) {
  return {
    ...target,
    query,
    caseSensitive: flags.caseSensitive,
    wholeWord: flags.wholeWord,
    regex: flags.regex,
    include: flags.include.trim() || undefined,
    exclude: flags.exclude.trim() || undefined,
  };
}

/**
 * The query and options, mirrored into the UI store so a reopened dialog
 * restores them.
 */
export function usePersistedSearchOptions() {
  const persisted = useUIStore((s) => s.textSearchState);
  const setPersisted = useUIStore((s) => s.setTextSearchState);

  // Local mirror of persisted state. We push back to the store on every
  // change so reopening restores everything; we also restore the local copy
  // on every mount from the latest persisted value.
  const [query, setQuery] = useState(persisted.query);
  const [caseSensitive, setCaseSensitive] = useState(persisted.caseSensitive);
  const [wholeWord, setWholeWord] = useState(persisted.wholeWord);
  const [regex, setRegex] = useState(persisted.regex);
  const [include, setInclude] = useState(persisted.include);
  const [exclude, setExclude] = useState(persisted.exclude);

  // Push every option change back into the store so a reopened dialog
  // restores them. The text inputs (query/include/exclude) flush on each
  // keystroke — cheap, debounce is for the network call only.
  useEffect(() => {
    setPersisted({ query, caseSensitive, wholeWord, regex, include, exclude });
  }, [query, caseSensitive, wholeWord, regex, include, exclude, setPersisted]);

  return {
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    wholeWord,
    setWholeWord,
    regex,
    setRegex,
    include,
    setInclude,
    exclude,
    setExclude,
  };
}
