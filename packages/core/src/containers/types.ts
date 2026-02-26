/**
 * Container lifecycle types for Podman-based app isolation per worktree.
 */

export type ContainerStatus =
  | 'starting'
  | 'running'
  | 'healthy'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface ContainerState {
  worktreePath: string;
  threadId: string;
  composeFile: string;
  /** Service name → host port */
  exposedPorts: Map<string, number>;
  status: ContainerStatus;
  startedAt: string;
  error?: string;
}

export interface StartContainersOptions {
  threadId: string;
  worktreePath: string;
  composeFile: string;
  envOverrides?: Record<string, string>;
}

export interface ContainerServiceOptions {
  /** Max time to wait for health check (default: 60_000ms) */
  healthCheckTimeoutMs?: number;
  /** Interval between health check polls (default: 2_000ms) */
  healthCheckIntervalMs?: number;
}

// ── Sandbox types ──────────────────────────────────────────────

export type SandboxStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface SandboxState {
  containerId: string;
  containerName: string;
  requestId: string;
  worktreePath: string;
  status: SandboxStatus;
}

export interface SandboxManagerOptions {
  /** Podman image name (default: 'funny-sandbox') */
  imageName?: string;
}
