/**
 * AgentOrchestrator — portable agent lifecycle manager.
 *
 * Owns process creation, start/stop/resume, and lifecycle events.
 * Does NOT touch DB, WebSocket, or any server infrastructure.
 * Consumers subscribe to events for persistence / broadcasting.
 */

import { EventEmitter } from 'events';
import type { AgentProvider, AgentModel, PermissionMode } from '@funny/shared';
import type { CLIMessage } from './types.js';
import type { IAgentProcess, IAgentProcessFactory } from './interfaces.js';
import { resolveModelId, resolvePermissionMode, getDefaultAllowedTools } from '@funny/shared/models';

// ── Types ─────────────────────────────────────────────────────────

export interface StartAgentOptions {
  threadId: string;
  prompt: string;
  cwd: string;
  model?: AgentModel;
  permissionMode?: PermissionMode;
  images?: any[];
  disallowedTools?: string[];
  allowedTools?: string[];
  provider?: AgentProvider;
  /** Session ID for resume — caller reads this from their storage. */
  sessionId?: string;
  maxTurns?: number;
  /** MCP servers to pass to the agent process (e.g., CDP browser tools) */
  mcpServers?: Record<string, any>;
  /** Custom spawn function for sandboxed execution (e.g., Podman container) */
  spawnClaudeCodeProcess?: (options: any) => any;
}

export interface OrchestratorEvents {
  'agent:started': (threadId: string) => void;
  'agent:message': (threadId: string, msg: CLIMessage) => void;
  'agent:error': (threadId: string, error: Error) => void;
  'agent:stopped': (threadId: string) => void;
  'agent:unexpected-exit': (threadId: string, code: number | null) => void;
  /** Emitted when a session resume fails and the session ID is discarded. */
  'agent:session-cleared': (threadId: string) => void;
}

// ── Orchestrator ──────────────────────────────────────────────────

export class AgentOrchestrator extends EventEmitter {
  private activeAgents = new Map<string, IAgentProcess>();
  private resultReceived = new Set<string>();
  private manuallyStopped = new Set<string>();

  constructor(private processFactory: IAgentProcessFactory) {
    super();
  }

  // ── Public API ────────────────────────────────────────────────

  async startAgent(options: StartAgentOptions): Promise<void> {
    const {
      threadId,
      prompt,
      cwd,
      model = 'sonnet',
      permissionMode = 'autoEdit',
      images,
      disallowedTools,
      allowedTools,
      provider = 'claude',
      sessionId,
      maxTurns = 200,
      mcpServers,
      spawnClaudeCodeProcess,
    } = options;

    console.log(`[orchestrator] start thread=${threadId} provider=${provider} model=${model} cwd=${cwd}`);

    // Kill existing process if still running
    const existing = this.activeAgents.get(threadId);
    if (existing && !existing.exited) {
      console.log(`[orchestrator] stopping existing agent for thread=${threadId} before restart`);
      this.manuallyStopped.add(threadId);
      try { await existing.kill(); } catch { /* best-effort */ }
      this.activeAgents.delete(threadId);
    }

    // Clear stale state
    this.resultReceived.delete(threadId);

    // Build effective prompt for session resume
    const isResume = !!sessionId;
    let effectivePrompt = prompt;
    if (isResume) {
      console.log(`[orchestrator] Resuming session=${sessionId} for thread=${threadId}`);
      effectivePrompt = `[SYSTEM NOTE: This is a session resume after an interruption. Your previous session was interrupted mid-execution. Continue from where you left off. Do NOT re-plan or start over — pick up execution from the last completed step.]\n\n${prompt}`;
    }

    // Resolve model ID and permission mode via registry
    const resolvedModel = resolveModelId(provider, model);
    const cliPermissionMode = resolvePermissionMode(provider, permissionMode);

    // When resuming Claude, override 'plan' permission mode to 'acceptEdits'
    const effectivePermissionMode = (isResume && cliPermissionMode === 'plan')
      ? 'acceptEdits'
      : cliPermissionMode;

    // Spawn agent process
    const effectiveAllowedTools = allowedTools ?? getDefaultAllowedTools(provider);
    const createAndWireProcess = (useSessionId?: string): IAgentProcess => {
      const proc = this.processFactory.create({
        prompt: effectivePrompt,
        cwd,
        model: resolvedModel,
        permissionMode: effectivePermissionMode,
        allowedTools: effectiveAllowedTools,
        disallowedTools,
        maxTurns,
        sessionId: useSessionId,
        images,
        provider,
        mcpServers,
        spawnClaudeCodeProcess,
      });

      this.activeAgents.set(threadId, proc);
      this.resultReceived.delete(threadId);

      proc.on('message', (msg: CLIMessage) => {
        if (msg.type === 'result') {
          if (this.manuallyStopped.has(threadId)) {
            return; // Suppress result messages for manually stopped agents
          }
          this.resultReceived.add(threadId);
        }
        this.emit('agent:message', threadId, msg);
      });

      proc.on('error', (err: Error) => {
        console.error(`[orchestrator] Error in thread ${threadId}:`, err);
        if (!this.resultReceived.has(threadId) && !this.manuallyStopped.has(threadId)) {
          this.emit('agent:error', threadId, err);
        }
      });

      proc.on('exit', (code: number | null) => {
        this.activeAgents.delete(threadId);

        if (this.manuallyStopped.has(threadId)) {
          this.manuallyStopped.delete(threadId);
          this.resultReceived.delete(threadId);
          return;
        }

        if (!this.resultReceived.has(threadId)) {
          this.emit('agent:unexpected-exit', threadId, code);
        }

        // Defer cleanup so the error handler can still check resultReceived
        // if an error event fires shortly after exit (e.g., container teardown).
        setTimeout(() => this.resultReceived.delete(threadId), 1000);
      });

      return proc;
    };

    // If resuming, wrap in a retry that falls back to a fresh session
    if (isResume) {
      const agentProcess = createAndWireProcess(sessionId);
      const resumeSuccess = await new Promise<boolean>((resolve) => {
        let gotMessage = false;
        const onMessage = () => { gotMessage = true; resolve(true); };
        const onError = () => { if (!gotMessage) resolve(false); };
        const onExit = () => { if (!gotMessage) resolve(false); };

        agentProcess.on('message', onMessage);
        agentProcess.on('error', onError);
        agentProcess.on('exit', onExit);

        try {
          agentProcess.start();
        } catch {
          resolve(false);
          return;
        }

        // Give the process a short window to fail (instant crash = resume failure)
        setTimeout(() => resolve(true), 3000);
      });

      if (resumeSuccess) {
        this.emit('agent:started', threadId);
        return;
      }

      // Resume failed — retry without session ID (fresh conversation)
      console.warn(`[orchestrator] Resume failed for thread=${threadId}, retrying without session`);
      this.emit('agent:session-cleared', threadId);
      const freshProcess = createAndWireProcess(undefined);
      try {
        freshProcess.start();
        this.emit('agent:started', threadId);
      } catch (err) {
        this.activeAgents.delete(threadId);
        throw err;
      }
      return;
    }

    const agentProcess = createAndWireProcess(sessionId);

    // Start the process
    try {
      agentProcess.start();
      this.emit('agent:started', threadId);
    } catch (err) {
      this.activeAgents.delete(threadId);
      throw err;
    }
  }

  async stopAgent(threadId: string): Promise<void> {
    const proc = this.activeAgents.get(threadId);
    if (proc) {
      this.manuallyStopped.add(threadId);
      try {
        await proc.kill();
      } catch (e) {
        console.error(`[orchestrator] Error killing process for thread ${threadId}:`, e);
      }
      this.activeAgents.delete(threadId);
    }
    this.emit('agent:stopped', threadId);
  }

  isRunning(threadId: string): boolean {
    return this.activeAgents.has(threadId);
  }

  /**
   * Clean up all in-memory state for a thread.
   * Call when deleting/archiving a thread.
   */
  cleanupThread(threadId: string): void {
    this.activeAgents.delete(threadId);
    this.resultReceived.delete(threadId);
    this.manuallyStopped.delete(threadId);
  }

  /**
   * Kill all active agent processes.
   */
  async stopAll(): Promise<void> {
    const entries = [...this.activeAgents.entries()];
    if (entries.length === 0) return;
    console.log(`[orchestrator] Stopping ${entries.length} active agent(s)...`);
    await Promise.allSettled(
      entries.map(async ([threadId, proc]) => {
        try {
          await proc.kill();
        } catch (e) {
          console.error(`[orchestrator] Error killing agent for thread ${threadId}:`, e);
        }
        this.activeAgents.delete(threadId);
      })
    );
    console.log('[orchestrator] All agents stopped.');
  }
}
