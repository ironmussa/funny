export type RepoMode = 'clone' | 'mount';

export interface RuntimeConfig {
  repoMode: RepoMode;
  repoUrl?: string;
  repoRef?: string;
  workBranch?: string;
  gitToken?: string;
  gitTokenFile?: string;
  gitUsername: string;
  workspacePath: string;
  funnyPort: number;
  clientOrigin?: string;
  authMode: 'local' | 'multi';
  funnyDataDir: string;
  enableRuntime: boolean;
  enableStreaming: boolean;
  streamViewerPort: number;
  streamWsPort: number;
  novncPort: number;
  chromeDebugPort: number;
  startUrl: string;
}

export interface ResolvedGitCredentials {
  token: string;
  username: string;
}

export interface PreparedWorkspace {
  workspacePath: string;
  mode: RepoMode;
  cloned: boolean;
  activeRef: string;
  workBranch?: string;
}
