import { request } from './_core';

export type RankedFileSearchTarget = { path: string } | { threadId: string };

export interface RankedFileSearchMatch {
  path: string;
  indices: number[];
}

export interface RankedFileSearchResponse {
  matches: RankedFileSearchMatch[];
  total: number;
  truncated: boolean;
  basePath: string;
}

export const browseApi = {
  browseRoots: () => request<{ roots: string[]; home: string }>('/browse/roots'),
  browseList: (path: string) =>
    request<{
      path: string;
      parent: string | null;
      dirs: Array<{ name: string; path: string }>;
      error?: string;
    }>(`/browse/list?path=${encodeURIComponent(path)}`),
  openInEditor: (path: string, editor: string) =>
    request<{ ok: boolean }>('/browse/open-in-editor', {
      method: 'POST',
      body: JSON.stringify({ path, editor }),
    }),
  openDirectory: (target: { path: string } | { threadId: string }) =>
    request<{ ok: boolean }>('/browse/open-directory', {
      method: 'POST',
      body: JSON.stringify(target),
    }),
  repoName: (path: string) =>
    request<{ name: string }>(`/browse/repo-name?path=${encodeURIComponent(path)}`),
  remoteUrl: (path: string) =>
    request<{ url: string | null }>(`/browse/remote-url?path=${encodeURIComponent(path)}`),
  gitInit: (path: string) =>
    request<{ ok: boolean }>('/browse/git-init', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  createDirectory: (parent: string, name: string) =>
    request<{ ok: boolean; path: string }>('/browse/create-directory', {
      method: 'POST',
      body: JSON.stringify({ parent, name }),
    }),
  browseFiles: (path: string, query?: string, limit?: number) => {
    const params = new URLSearchParams({ path });
    if (query) params.set('query', query);
    if (limit) params.set('limit', String(limit));
    return request<{
      files: Array<{ path: string; type: 'file' | 'folder' } | string>;
      truncated: boolean;
    }>(`/browse/files?${params.toString()}`);
  },
  searchFiles: (
    target: RankedFileSearchTarget,
    query: string,
    limit?: number,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({ q: query });
    if ('threadId' in target) {
      params.set('threadId', target.threadId);
    } else {
      params.set('path', target.path);
    }
    if (limit) params.set('limit', String(limit));
    return request<RankedFileSearchResponse>(`/search/files?${params.toString()}`, { signal });
  },
  trackFileSelection: (target: RankedFileSearchTarget, query: string, relativePath: string) =>
    request<{ ok: boolean }>('/search/files/selection', {
      method: 'POST',
      body: JSON.stringify({ ...target, query, relativePath }),
    }),
  searchSymbols: (path: string, query?: string, file?: string) => {
    const params = new URLSearchParams({ path });
    if (query) params.set('query', query);
    if (file) params.set('file', file);
    return request<{
      symbols: Array<{
        name: string;
        kind: string;
        filePath: string;
        line: number;
        endLine?: number;
        containerName?: string;
      }>;
      truncated: boolean;
      indexed: boolean;
    }>(`/browse/symbols?${params.toString()}`);
  },
  triggerSymbolIndex: (path: string) =>
    request<{ ok: boolean }>('/browse/symbols/index', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  /**
   * Full-text search across a thread cwd or selected project path
   * (VSCode-style "Search in Files"). Runs ripgrep on the runner and groups
   * matches by file. Truncates at `maxResults` (default 1000) and surfaces a
   * `truncated` flag so the UI can prompt for a more specific query.
   */
  searchText: (params: {
    threadId?: string;
    path?: string;
    query: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
    include?: string;
    exclude?: string;
    maxResults?: number;
  }) => {
    const qs = new URLSearchParams({ q: params.query });
    if (params.threadId) qs.set('threadId', params.threadId);
    if (params.path) qs.set('path', params.path);
    if (params.caseSensitive) qs.set('caseSensitive', 'true');
    if (params.wholeWord) qs.set('wholeWord', 'true');
    if (params.regex) qs.set('regex', 'true');
    if (params.include) qs.set('include', params.include);
    if (params.exclude) qs.set('exclude', params.exclude);
    if (params.maxResults) qs.set('maxResults', String(params.maxResults));
    return request<{
      files: Array<{
        path: string;
        matches: Array<{
          line: number;
          text: string;
          ranges: Array<{ start: number; end: number }>;
        }>;
      }>;
      totalMatches: number;
      truncated: boolean;
      durationMs: number;
      basePath: string;
    }>(`/search/text?${qs.toString()}`);
  },
};
