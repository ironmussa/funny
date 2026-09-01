import type { DomainError } from '@funny/shared/errors';
import type { Result, ResultAsync } from 'neverthrow';

export interface ProjectFileMatch {
  path: string;
  score: number;
  indices: number[];
}

export interface ProjectFileSearchResult {
  matches: ProjectFileMatch[];
  total: number;
  truncated: boolean;
  indexedFiles: number;
}

export interface ProjectTextSearchOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  include?: string;
  exclude?: string;
  maxResults?: number;
}

export interface ProjectTextLineMatch {
  line: number;
  text: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface ProjectTextFileResult {
  path: string;
  matches: ProjectTextLineMatch[];
}

export interface ProjectTextSearchResult {
  files: ProjectTextFileResult[];
  totalMatches: number;
  truncated: boolean;
  durationMs: number;
}

export interface ProjectSearchHealth {
  available: boolean;
  version: string | null;
  scanState: 'initializing' | 'ready' | 'scanning' | 'failed' | 'disposed';
  indexedFiles: number;
  watcherReady: boolean;
  failureReason?: ProjectSearchFailureReason;
}

export type ProjectSearchFailureReason =
  | 'native-load'
  | 'initialization'
  | 'scan'
  | 'health-check'
  | 'scan-progress'
  | 'file-picker';

export interface ProjectSearchNativeHealth {
  available: boolean;
  version: string | null;
  failureReason?: ProjectSearchFailureReason;
}

export interface ProjectSearchProvider {
  readonly cwd: string;
  readonly version: number;
  listFiles(): Result<string[], DomainError>;
  searchFiles(query: string, limit: number): Result<ProjectFileSearchResult, DomainError>;
  searchText(options: ProjectTextSearchOptions): ResultAsync<ProjectTextSearchResult, DomainError>;
  trackSelection(query: string, relativePath: string): Result<void, DomainError>;
  refreshGitStatus(): Result<void, DomainError>;
  rescan(): ResultAsync<void, DomainError>;
  health(): ProjectSearchHealth;
  dispose(): void;
}
