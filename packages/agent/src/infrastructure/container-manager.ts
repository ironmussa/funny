/**
 * ContainerManager — orchestrates container lifecycle for pipelines.
 *
 * ALWAYS creates a Podman sandbox container for the pipeline agent.
 * Podman is a hard requirement — if not installed, the pipeline fails
 * with a clear error message.
 *
 * If the project also has a compose file, project services (and CDP
 * browser) are started alongside the sandbox.
 *
 * Uses SandboxManager, ContainerService, and createCdpMcpServer from
 * @funny/core as the underlying libraries.
 */

import {
  SandboxManager,
  ContainerService,
  createCdpMcpServer,
} from '@funny/core/containers';
import type { CdpMcpServerResult } from '@funny/core/containers';
import { logger } from './logger.js';

export interface ContainerSetupResult {
  /** Custom spawn function — ALWAYS present (sandbox is mandatory). */
  spawnClaudeCodeProcess: (options: any) => any;
  /** MCP servers (CDP browser) — only present when project has a compose file. */
  mcpServers?: Record<string, any>;
}

export class ContainerManager {
  private sandboxManager: SandboxManager;
  private containerService: ContainerService;
  private cdpInstances = new Map<string, CdpMcpServerResult>();

  constructor() {
    this.sandboxManager = new SandboxManager();
    this.containerService = new ContainerService();
  }

  /**
   * Set up the pipeline execution environment:
   *
   * 1. ALWAYS start a sandbox container (agent runs inside it)
   * 2. OPTIONALLY start project services if a compose file exists
   *
   * Throws if Podman is not installed.
   */
  async setup(
    worktreePath: string,
    requestId: string,
  ): Promise<ContainerSetupResult> {
    // 1. Verify Podman is available — hard requirement
    const podmanAvailable = await this.sandboxManager.isPodmanAvailable();
    if (!podmanAvailable) {
      throw new Error(
        'Podman is required to run pipelines but was not found in $PATH. '
        + 'Install it from https://podman.io/docs/installation',
      );
    }

    // 2. ALWAYS: start sandbox container with worktree mounted
    logger.info({ requestId, worktreePath }, 'Starting sandbox container');
    await this.sandboxManager.startSandbox({ requestId, worktreePath });
    const spawnClaudeCodeProcess = this.sandboxManager.createSpawnFn(requestId);

    // 3. OPTIONAL: start project services if compose file exists
    let mcpServers: Record<string, any> | undefined;
    const composeFile = await this.containerService.detectComposeFile(worktreePath);

    if (composeFile) {
      logger.info({ requestId, worktreePath, composeFile }, 'Starting project containers');

      try {
        const state = await this.containerService.startContainers({
          threadId: requestId,
          worktreePath,
          composeFile,
        });

        await this.containerService.waitForHealthy(worktreePath);

        const firstPort = [...state.exposedPorts.values()][0];
        if (firstPort) {
          const appUrl = `http://localhost:${firstPort}`;
          logger.info({ requestId, appUrl }, 'Project containers healthy — creating CDP browser');
          const cdp = createCdpMcpServer({ appUrl });
          this.cdpInstances.set(worktreePath, cdp);
          mcpServers = { 'cdp-browser': cdp.server };
        }
      } catch (err: any) {
        logger.warn(
          { requestId, err: err.message },
          'Project container setup failed — continuing without browser tools',
        );
      }
    }

    return { spawnClaudeCodeProcess, mcpServers };
  }

  /**
   * Cleanup sandbox + project containers for a single pipeline run.
   * Call when the pipeline completes, fails, or is stopped.
   */
  async cleanup(worktreePath: string, requestId: string): Promise<void> {
    // Dispose CDP browser
    const cdp = this.cdpInstances.get(worktreePath);
    if (cdp) {
      await cdp.dispose().catch(() => {});
      this.cdpInstances.delete(worktreePath);
    }

    // Stop project containers
    await this.containerService.stopContainers(worktreePath).catch((err: any) => {
      logger.warn({ err: err.message, worktreePath }, 'Error stopping project containers');
    });

    // Stop sandbox container
    await this.sandboxManager.stopSandbox(requestId).catch((err: any) => {
      logger.warn({ err: err.message, requestId }, 'Error stopping sandbox');
    });
  }

  /**
   * Cleanup all containers and browsers.
   * Call during server shutdown.
   */
  async cleanupAll(): Promise<void> {
    for (const [, cdp] of this.cdpInstances) {
      await cdp.dispose().catch(() => {});
    }
    this.cdpInstances.clear();
    await this.containerService.stopAll();
    await this.sandboxManager.stopAll();
  }

  /**
   * Kill orphaned pipeline-sandbox-* containers from previous runs.
   * Call on startup to clean up after crashes or ungraceful shutdowns.
   */
  async killOrphans(): Promise<number> {
    return this.sandboxManager.killOrphans();
  }
}
