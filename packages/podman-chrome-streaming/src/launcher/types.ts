import type { RepoMode } from '../runtime/types.ts';

export interface LauncherStartRequest {
  containerName?: string;
  imageTag?: string;
  build?: 'always' | 'if-missing' | 'never';
  repoMode?: RepoMode;
  repoUrl?: string;
  repoRef?: string;
  workBranch?: string;
  hostRepoPath?: string;
  gitToken?: string;
  gitTokenFilePath?: string;
  gitUsername?: string;
  funnyPort?: number;
  clientOrigin?: string;
  authMode?: 'local' | 'multi';
  enableStreaming?: boolean;
  streamViewerPort?: number;
  streamWsPort?: number;
  novncPort?: number;
  chromeDebugPort?: number;
  startUrl?: string;
}

export interface LauncherStopRequest {
  containerName?: string;
  remove?: boolean;
}

export interface LauncherStatus {
  containerName: string;
  imageTag: string;
  exists: boolean;
  running: boolean;
  state?: string;
  machineIp?: string;
  funnyUrl?: string;
  streamUrl?: string;
  novncUrl?: string;
  chromeDebugUrl?: string;
  funnyMachineUrl?: string;
  streamMachineUrl?: string;
  novncMachineUrl?: string;
  chromeDebugMachineUrl?: string;
}

export interface ResolvedLauncherRequest {
  containerName: string;
  imageTag: string;
  build: 'always' | 'if-missing' | 'never';
  repoMode: RepoMode;
  repoUrl?: string;
  repoRef?: string;
  workBranch?: string;
  hostRepoPath?: string;
  gitToken?: string;
  gitTokenFilePath?: string;
  gitUsername: string;
  funnyPort: number;
  clientOrigin?: string;
  authMode: 'local' | 'multi';
  enableStreaming: boolean;
  streamViewerPort: number;
  streamWsPort: number;
  novncPort: number;
  chromeDebugPort: number;
  startUrl: string;
}
