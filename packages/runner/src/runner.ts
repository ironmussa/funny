/**
 * Main Runner service — orchestrates the HTTP client, WebSocket client,
 * agent handler, and git handler into a single lifecycle.
 *
 * The runner is project-agnostic. It registers as an available machine.
 * The central server assigns projects and dispatches tasks with a `cwd`.
 */

import { hostname } from 'os';
import { platform } from 'process';

import type { RunnerTask } from '@funny/shared/runner-protocol';

import { AgentHandler } from './agent-handler.js';
import { CentralClient } from './central-client.js';
import { handleGitOperation } from './git-handler.js';
import { RunnerWSClient } from './ws-client.js';

export interface RunnerOptions {
  /** Central server URL (e.g. "http://192.168.1.10:3001") */
  serverUrl: string;
  /** Friendly name for this runner */
  name: string;
  /** Optional base directory where repos live (for admin reference) */
  workspace?: string;
  /** Heartbeat interval in ms (default: 15000) */
  heartbeatInterval?: number;
  /** Task poll interval in ms (default: 5000) */
  pollInterval?: number;
}

export class Runner {
  private client: CentralClient;
  private wsClient: RunnerWSClient | null = null;
  private agentHandler: AgentHandler | null = null;
  private runnerId: string | null = null;
  private token: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private opts: Required<Omit<RunnerOptions, 'workspace'>> & { workspace?: string };

  constructor(opts: RunnerOptions) {
    this.opts = {
      heartbeatInterval: 15_000,
      pollInterval: 5_000,
      ...opts,
    };
    this.client = new CentralClient({ serverUrl: this.opts.serverUrl });
  }

  async start(): Promise<void> {
    console.info(`[runner] Registering with central server at ${this.opts.serverUrl}...`);

    // 1. Register with central server
    const reg = await this.client.register({
      name: this.opts.name,
      hostname: hostname(),
      os: platform,
      workspace: this.opts.workspace,
    });

    this.runnerId = reg.runnerId;
    this.token = reg.token;
    console.info(`[runner] Registered as ${this.runnerId}`);

    // 2. Connect WebSocket for agent streaming
    this.wsClient = new RunnerWSClient({
      serverUrl: this.opts.serverUrl,
      runnerId: this.runnerId,
      token: this.token,
      onCommand: (task) => this.handleTask(task),
    });
    this.wsClient.connect();

    // 3. Initialize agent handler
    this.agentHandler = new AgentHandler(this.wsClient);

    // 4. Start heartbeat loop
    this.running = true;
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.client.heartbeat({
          activeThreadIds: this.agentHandler?.getActiveThreadIds() ?? [],
        });
      } catch (err) {
        console.error('[runner] Heartbeat failed:', err);
      }
    }, this.opts.heartbeatInterval);

    // 5. Start task polling loop
    this.pollTimer = setInterval(async () => {
      try {
        const { tasks } = await this.client.pollTasks();
        for (const task of tasks) {
          await this.handleTask(task);
        }
      } catch {
        // Poll failures are expected during reconnection
      }
    }, this.opts.pollInterval);

    console.info(
      `[runner] Running. Heartbeat every ${this.opts.heartbeatInterval}ms, polling every ${this.opts.pollInterval}ms`,
    );
  }

  async stop(): Promise<void> {
    console.info('[runner] Shutting down...');
    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    await this.agentHandler?.stopAll();
    this.wsClient?.disconnect();
    console.info('[runner] Stopped.');
  }

  private async handleTask(task: RunnerTask): Promise<void> {
    console.info(
      `[runner] Handling task ${task.taskId} (${task.type}) for thread ${task.threadId}`,
    );

    try {
      switch (task.type) {
        case 'start_agent': {
          const payload = task.payload;
          if (payload.type !== 'start_agent') break;
          await this.agentHandler!.startAgent(task.threadId, payload);
          await this.client.reportTaskResult({
            taskId: task.taskId,
            success: true,
          });
          break;
        }

        case 'stop_agent': {
          await this.agentHandler!.stopAgent(task.threadId);
          await this.client.reportTaskResult({
            taskId: task.taskId,
            success: true,
          });
          break;
        }

        case 'send_message': {
          const payload = task.payload;
          if (payload.type !== 'send_message') break;
          // For follow-up messages, we start a new agent run with the message as prompt
          await this.agentHandler!.startAgent(task.threadId, {
            type: 'start_agent',
            prompt: payload.content,
            cwd: '', // Will be resolved by the central server before dispatching
            model: payload.model ?? 'sonnet',
            provider: 'claude',
            permissionMode: payload.permissionMode ?? 'autoEdit',
            images: payload.images,
          });
          await this.client.reportTaskResult({
            taskId: task.taskId,
            success: true,
          });
          break;
        }

        case 'git_operation': {
          const payload = task.payload;
          if (payload.type !== 'git_operation') break;
          const result = await handleGitOperation(payload.operation, payload.cwd, payload.params);
          await this.client.reportTaskResult({
            taskId: task.taskId,
            success: result.success,
            data: result.data,
            error: result.error,
          });
          break;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runner] Task ${task.taskId} failed:`, message);
      try {
        await this.client.reportTaskResult({
          taskId: task.taskId,
          success: false,
          error: message,
        });
      } catch {
        // If we can't report, the central server will time out the task
      }
    }
  }
}
