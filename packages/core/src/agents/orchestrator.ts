/**
 * AgentOrchestrator — portable agent lifecycle manager.
 *
 * Owns process creation, start/stop/resume, and lifecycle events.
 * Does NOT touch DB, WebSocket, or any server infrastructure.
 * Consumers subscribe to events for persistence / broadcasting.
 */

import { EventEmitter } from 'events';

import type { AgentProvider, AgentModel, PermissionMode } from '@funny/shared';
import {
  resolveModelId,
  resolvePermissionMode,
  resolveResumePermissionMode,
  getDefaultAllowedTools,
} from '@funny/shared/models';

import type { IAgentProcess, IAgentProcessFactory } from './interfaces.js';
import type { CLIMessage } from './types.js';

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
  /** Custom system prefix for resume — replaces the default "interrupted session" note. */
  systemPrefix?: string;
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
      systemPrefix,
    } = options;

    console.log(
      `[orchestrator] start thread=${threadId} provider=${provider} model=${model} cwd=${cwd}`,
    );

    // Kill existing process if still running
    const existing = this.activeAgents.get(threadId);
    if (existing && !existing.exited) {
      console.log(`[orchestrator] stopping existing agent for thread=${threadId} before restart`);
      this.manuallyStopped.add(threadId);
      try {
        await existing.kill();
      } catch {
        /* best-effort */
      }
      this.activeAgents.delete(threadId);
    }

    // Clear stale state
    this.resultReceived.delete(threadId);

    // Build effective prompt for session resume
    const isResume = !!sessionId;
    let effectivePrompt = prompt;
    if (isResume) {
      console.log(`[orchestrator] Resuming session=${sessionId} for thread=${threadId}`);
      const prefix =
        systemPrefix ??
        `[SYSTEM NOTE: This is a session resume after an interruption. Your previous session was interrupted mid-execution. Continue from where you left off. Do NOT re-plan or start over — pick up execution from the last completed step.]`;
      effectivePrompt = `${prefix}\n\n${prompt}`;
    }

    // Resolve model ID and permission mode via registry
    const resolvedModel = resolveModelId(provider, model);
    const cliPermissionMode = resolvePermissionMode(provider, permissionMode);

    // Provider-specific resume override (e.g., Claude's plan → acceptEdits)
    const effectivePermissionMode = isResume
      ? resolveResumePermissionMode(provider, cliPermissionMode)
      : cliPermissionMode;

    // Build shared process options
    const effectiveAllowedTools = allowedTools ?? getDefaultAllowedTools(provider);
    const processOpts = {
      prompt: effectivePrompt,
      cwd,
      model: resolvedModel,
      permissionMode: effectivePermissionMode,
      allowedTools: effectiveAllowedTools,
      disallowedTools,
      maxTurns,
      images,
      provider,
      mcpServers,
      spawnClaudeCodeProcess,
    };

    if (isResume) {
      this.startWithResume(threadId, processOpts, sessionId!);
    } else {
      this.startFresh(threadId, processOpts, sessionId);
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
   * Extract active agent processes WITHOUT killing them.
   * Used to preserve agents across bun --watch restarts.
   * Returns the current active agents and clears internal state.
   */
  extractActiveAgents(): Map<string, IAgentProcess> {
    const agents = new Map(this.activeAgents);
    // Detach: remove all our listeners so the old orchestrator
    // doesn't interfere when these processes emit events.
    for (const [, proc] of agents) {
      proc.removeAllListeners();
    }
    this.activeAgents.clear();
    this.resultReceived.clear();
    this.manuallyStopped.clear();
    return agents;
  }

  /**
   * Adopt a surviving agent process (from a previous module evaluation).
   * Wires fresh event handlers so messages flow to the new DB + WebSocket.
   */
  adoptProcess(threadId: string, proc: IAgentProcess): void {
    this.wireProcessHandlers(proc, threadId);
    console.log(`[orchestrator] Adopted surviving agent for thread=${threadId}`);
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
      }),
    );
    console.log('[orchestrator] All agents stopped.');
  }

  // ── Process wiring ─────────────────────────────────────────────

  /**
   * Wire the standard message/error/exit handlers to a process.
   * Used for both fresh starts and as a fallback after failed resume.
   */
  private wireProcessHandlers(proc: IAgentProcess, threadId: string): void {
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
  }

  /**
   * Wire resume-aware handlers that detect stale sessions and auto-retry.
   * If the process exits without ever producing a message, falls back
   * to a fresh session via `onStaleSession`.
   */
  private wireResumeHandlers(
    proc: IAgentProcess,
    threadId: string,
    onStaleSession: () => void,
  ): void {
    this.activeAgents.set(threadId, proc);
    this.resultReceived.delete(threadId);

    let gotMessage = false;

    proc.on('message', (msg: CLIMessage) => {
      gotMessage = true;
      if (msg.type === 'result') {
        if (this.manuallyStopped.has(threadId)) return;
        this.resultReceived.add(threadId);
      }
      this.emit('agent:message', threadId, msg);
    });

    proc.on('error', (err: Error) => {
      if (!gotMessage) {
        // Resume crashed before producing any output — will retry on exit
        console.warn(
          `[orchestrator] Resume error for thread=${threadId}:`,
          String(err).slice(0, 200),
        );
        return;
      }
      // Session was live (got messages), so this is a real error
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

      if (!gotMessage) {
        // Process died without ever sending a message → stale session, retry fresh
        onStaleSession();
        return;
      }

      if (!this.resultReceived.has(threadId)) {
        this.emit('agent:unexpected-exit', threadId, code);
      }
      setTimeout(() => this.resultReceived.delete(threadId), 1000);
    });
  }

  // ── Start strategies ───────────────────────────────────────────

  /** Start a fresh (non-resume) agent process. */
  private startFresh(threadId: string, processOpts: Record<string, any>, sessionId?: string): void {
    const proc = this.processFactory.create({ ...processOpts, sessionId } as any);
    this.wireProcessHandlers(proc, threadId);

    try {
      proc.start();
      this.emit('agent:started', threadId);
    } catch (err) {
      this.activeAgents.delete(threadId);
      throw err;
    }
  }

  /**
   * Start a resume agent process with auto-retry on stale session.
   * If the session is stale (crashes before producing any output),
   * transparently falls back to a fresh session.
   */
  private startWithResume(
    threadId: string,
    processOpts: Record<string, any>,
    sessionId: string,
  ): void {
    const resumeProc = this.processFactory.create({ ...processOpts, sessionId } as any);

    const retryFresh = () => {
      console.warn(`[orchestrator] Resume failed for thread=${threadId}, retrying without session`);
      this.emit('agent:session-cleared', threadId);

      const freshProc = this.processFactory.create({ ...processOpts, sessionId: undefined } as any);
      this.wireProcessHandlers(freshProc, threadId);

      try {
        freshProc.start();
      } catch (freshErr) {
        this.activeAgents.delete(threadId);
        this.emit(
          'agent:error',
          threadId,
          freshErr instanceof Error ? freshErr : new Error(String(freshErr)),
        );
      }
    };

    this.wireResumeHandlers(resumeProc, threadId, retryFresh);

    try {
      resumeProc.start();
      this.emit('agent:started', threadId);
    } catch {
      retryFresh();
    }
  }
}
