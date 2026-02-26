/**
 * ContainerService — manages Podman container lifecycle per worktree.
 *
 * Detects compose files, launches containers with dynamic port allocation,
 * polls health checks, and cleans up on thread stop/archive/delete.
 * Uses the same `execute()` utility as git operations.
 */

import { existsSync } from 'fs';
import { resolve } from 'path';

import { execute } from '../git/process.js';
import type { ContainerState, ContainerServiceOptions, StartContainersOptions } from './types.js';

const COMPOSE_FILE_NAMES = [
  'compose.yml',
  'compose.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
];

const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_INTERVAL_MS = 2_000;

export class ContainerService {
  private activeContainers = new Map<string, ContainerState>();
  private readonly healthCheckTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;

  constructor(options: ContainerServiceOptions = {}) {
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  }

  // ── Detection ──────────────────────────────────────────────────

  /**
   * Check if a directory contains a compose file.
   * Returns the filename if found, null otherwise.
   */
  async detectComposeFile(dirPath: string): Promise<string | null> {
    for (const name of COMPOSE_FILE_NAMES) {
      if (existsSync(resolve(dirPath, name))) {
        return name;
      }
    }
    return null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Start containers defined in the compose file.
   * Returns the container state with exposed ports.
   */
  async startContainers(opts: StartContainersOptions): Promise<ContainerState> {
    const { threadId, worktreePath, composeFile, envOverrides } = opts;

    const state: ContainerState = {
      worktreePath,
      threadId,
      composeFile,
      exposedPorts: new Map(),
      status: 'starting',
      startedAt: new Date().toISOString(),
    };

    this.activeContainers.set(worktreePath, state);

    try {
      // Build environment with overrides
      const env: Record<string, string> = {
        ...envOverrides,
      };

      console.log(`[containers] Starting containers for thread=${threadId} in ${worktreePath}`);

      // Launch containers
      await execute('podman', ['compose', '-f', composeFile, 'up', '-d', '--build'], {
        cwd: worktreePath,
        env,
        timeout: 120_000,
      });

      state.status = 'running';

      // Parse exposed ports from running containers
      await this.parseExposedPorts(state);

      console.log(
        `[containers] Running for thread=${threadId}, ports:`,
        Object.fromEntries(state.exposedPorts),
      );

      return state;
    } catch (error: any) {
      state.status = 'failed';
      state.error = error.message || String(error);
      console.error(`[containers] Failed to start for thread=${threadId}:`, state.error);
      throw error;
    }
  }

  /**
   * Wait for the first exposed port to respond to HTTP requests.
   */
  async waitForHealthy(worktreePath: string, timeoutMs?: number): Promise<void> {
    const state = this.activeContainers.get(worktreePath);
    if (!state || state.exposedPorts.size === 0) return;

    const port = [...state.exposedPorts.values()][0];
    const timeout = timeoutMs ?? this.healthCheckTimeoutMs;
    const url = `http://localhost:${port}`;
    const start = Date.now();

    console.log(`[containers] Waiting for health check at ${url}...`);

    while (Date.now() - start < timeout) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok || response.status < 500) {
          state.status = 'healthy';
          console.log(`[containers] Healthy at ${url} (${Date.now() - start}ms)`);
          return;
        }
      } catch {
        // Not ready yet
      }
      await sleep(this.healthCheckIntervalMs);
    }

    console.warn(`[containers] Health check timed out after ${timeout}ms for ${url}`);
    // Don't fail — the container is running, just not responding yet
  }

  /**
   * Stop and remove containers for a worktree.
   */
  async stopContainers(worktreePath: string): Promise<void> {
    const state = this.activeContainers.get(worktreePath);
    if (!state) return;

    state.status = 'stopping';
    console.log(`[containers] Stopping containers for thread=${state.threadId}`);

    try {
      await execute('podman', ['compose', '-f', state.composeFile, 'down', '--remove-orphans'], {
        cwd: worktreePath,
        timeout: 30_000,
        reject: false,
      });
    } catch (error: any) {
      console.warn(`[containers] Error stopping containers: ${error.message}`);
    }

    state.status = 'stopped';
    this.activeContainers.delete(worktreePath);
  }

  // ── Queries ────────────────────────────────────────────────────

  getState(worktreePath: string): ContainerState | undefined {
    return this.activeContainers.get(worktreePath);
  }

  /**
   * Stop all running containers. Called during server shutdown.
   */
  async stopAll(): Promise<void> {
    const entries = [...this.activeContainers.entries()];
    if (entries.length === 0) return;

    console.log(`[containers] Stopping ${entries.length} container group(s)...`);
    await Promise.allSettled(entries.map(([worktreePath]) => this.stopContainers(worktreePath)));
    console.log('[containers] All containers stopped.');
  }

  // ── Internal ───────────────────────────────────────────────────

  /**
   * Parse exposed ports from `podman compose ps --format json`.
   */
  private async parseExposedPorts(state: ContainerState): Promise<void> {
    try {
      const result = await execute(
        'podman',
        ['compose', '-f', state.composeFile, 'ps', '--format', 'json'],
        { cwd: state.worktreePath, reject: false },
      );

      if (result.exitCode !== 0 || !result.stdout.trim()) return;

      // Podman compose ps --format json returns an array of container objects
      const containers = JSON.parse(result.stdout);
      const list = Array.isArray(containers) ? containers : [containers];

      for (const container of list) {
        // Extract service name from container name (typically project-service-1)
        const name: string = container.Name || container.Names || '';
        const serviceName = extractServiceName(name);

        // Parse port mappings from Ports array or string
        const ports = container.Ports;
        if (Array.isArray(ports)) {
          for (const p of ports) {
            if (p.host_port || p.hostPort) {
              const hostPort = p.host_port || p.hostPort;
              state.exposedPorts.set(serviceName, Number(hostPort));
              break; // Take the first mapped port per service
            }
          }
        } else if (typeof ports === 'string' && ports.includes('->')) {
          // Format: "0.0.0.0:8080->80/tcp"
          const match = ports.match(/:(\d+)->/);
          if (match) {
            state.exposedPorts.set(serviceName, Number(match[1]));
          }
        }
      }
    } catch (error: any) {
      console.warn(`[containers] Could not parse ports: ${error.message}`);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract service name from a container name like "project-service-1".
 */
function extractServiceName(containerName: string): string {
  const parts = containerName.split('-');
  if (parts.length >= 3) {
    // Remove project prefix and instance suffix
    return parts.slice(1, -1).join('-');
  }
  return containerName || 'default';
}
