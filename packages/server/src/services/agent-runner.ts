import { wsBroker } from './ws-broker.js';
import * as tm from './thread-manager.js';
import type { WSEvent, ClaudeModel, PermissionMode } from '@a-parallel/shared';
import {
  ClaudeProcess,
  type CLIMessage,
  type ClaudeProcessOptions,
} from './claude-process.js';
import type {
  IThreadManager,
  IWSBroker,
  IClaudeProcess,
  IClaudeProcessFactory,
} from './interfaces.js';
import { AgentStateTracker } from './agent-state.js';
import { AgentMessageHandler } from './agent-message-handler.js';
import { AgentControlHandler } from './agent-control-handler.js';

const PERMISSION_MAP: Record<PermissionMode, string> = {
  plan: 'plan',
  autoEdit: 'acceptEdits',
  confirmEdit: 'default',
};

const MODEL_MAP: Record<ClaudeModel, string> = {
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'NotebookEdit',
];

// ── AgentRunner class ───────────────────────────────────────────

export class AgentRunner {
  private state: AgentStateTracker;
  private messageHandler: AgentMessageHandler;
  private controlHandler: AgentControlHandler;

  constructor(
    private threadManager: IThreadManager,
    private wsBroker: IWSBroker,
    private processFactory: IClaudeProcessFactory,
  ) {
    this.state = new AgentStateTracker();
    this.messageHandler = new AgentMessageHandler(this.state, threadManager, wsBroker);
    this.controlHandler = new AgentControlHandler(this.state, threadManager, wsBroker);
  }

  private emitWS(threadId: string, type: WSEvent['type'], data: unknown): void {
    const event = { type, threadId, data } as WSEvent;
    const thread = this.threadManager.getThread(threadId);
    const userId = thread?.userId;
    if (userId) {
      this.wsBroker.emitToUser(userId, event);
    } else {
      this.wsBroker.emit(event);
    }
  }

  // ── Public API ─────────────────────────────────────────────────

  async startAgent(
    threadId: string,
    prompt: string,
    cwd: string,
    model: ClaudeModel = 'sonnet',
    permissionMode: PermissionMode = 'autoEdit',
    images?: any[],
    disallowedTools?: string[],
    allowedTools?: string[],
  ): Promise<void> {
    console.log(`[agent] start thread=${threadId} model=${model} cwd=${cwd}`);

    // Check if we're resuming an existing active session
    const existing = this.state.activeAgents.get(threadId);
    if (existing && !existing.exited) {
      const resumed = this.tryResumeWithUserInput(threadId, prompt, model, permissionMode, images);
      if (resumed) return;

      // Explicitly STOP if we are restarting and it's not a resume flow
      console.log(`[agent] stopping existing agent for thread=${threadId} before restart`);
      this.state.manuallyStopped.add(threadId);
      try { await existing.kill(); } catch { /* best-effort */ }
      this.state.activeAgents.delete(threadId);
    }

    // Clear stale state from previous runs
    this.state.clearRunState(threadId);

    // Update thread status
    this.threadManager.updateThread(threadId, { status: 'running' });

    // Auto-transition stage to 'in_progress' from 'backlog' or 'review'
    const currentThread = this.threadManager.getThread(threadId);
    if (currentThread && (currentThread.stage === 'review' || currentThread.stage === 'backlog')) {
      this.threadManager.updateThread(threadId, { stage: 'in_progress' });
    }

    const updatedThread = this.threadManager.getThread(threadId);
    this.emitWS(threadId, 'agent:status', { status: 'running', stage: updatedThread?.stage });

    // Save user message
    this.threadManager.insertMessage({
      threadId,
      role: 'user',
      content: prompt,
      images: images ? JSON.stringify(images) : null,
      model,
      permissionMode,
    });

    // Check if we're resuming a previous session
    const thread = this.threadManager.getThread(threadId);
    const isResume = !!thread?.sessionId;

    let effectivePrompt = prompt;
    if (isResume) {
      console.log(`[agent] Resuming session=${thread!.sessionId} for thread=${threadId}`);
      effectivePrompt = `[SYSTEM NOTE: This is a session resume after an interruption. Your previous session was interrupted mid-execution. Continue from where you left off. Do NOT re-plan or start over — pick up execution from the last completed step.]\n\n${prompt}`;
    }

    // When resuming, override 'plan' permission mode to 'acceptEdits'
    const cliPermissionMode = PERMISSION_MAP[permissionMode];
    const effectivePermissionMode = (isResume && cliPermissionMode === 'plan')
      ? 'acceptEdits'
      : cliPermissionMode;

    // Spawn claude CLI process
    const effectiveAllowedTools = allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    const claudeProcess = this.processFactory.create({
      prompt: effectivePrompt,
      cwd,
      model: MODEL_MAP[model],
      permissionMode: effectivePermissionMode,
      allowedTools: effectiveAllowedTools,
      disallowedTools,
      maxTurns: 200,
      sessionId: thread?.sessionId ?? undefined,
      images,
    });

    this.state.activeAgents.set(threadId, claudeProcess);
    this.state.resultReceived.delete(threadId);

    // Wire up event handlers
    claudeProcess.on('message', (msg: CLIMessage) => {
      this.messageHandler.handle(threadId, msg);
    });

    claudeProcess.on('control_request', (msg: any) => {
      this.controlHandler.handle(threadId, msg, claudeProcess);
    });

    claudeProcess.on('error', (err: Error) => {
      console.error(`[agent] Error in thread ${threadId}:`, err);
      if (!this.state.resultReceived.has(threadId) && !this.state.manuallyStopped.has(threadId)) {
        this.threadManager.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });
        this.emitWS(threadId, 'agent:error', { error: err.message });
        this.emitWS(threadId, 'agent:status', { status: 'failed' });
      }
    });

    claudeProcess.on('exit', (code: number | null) => {
      this.state.activeAgents.delete(threadId);

      if (this.state.manuallyStopped.has(threadId)) {
        this.state.manuallyStopped.delete(threadId);
        this.state.resultReceived.delete(threadId);
        return;
      }

      if (!this.state.resultReceived.has(threadId)) {
        this.threadManager.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });
        this.emitWS(threadId, 'agent:error', {
          error: 'Agent process exited unexpectedly without a result',
        });
        this.emitWS(threadId, 'agent:status', { status: 'failed' });
      }

      this.state.resultReceived.delete(threadId);
    });

    // Start the process
    try {
      claudeProcess.start();
    } catch (err: any) {
      console.error(`[agent] Failed to start Claude process for thread=${threadId}:`, err.message);
      this.state.activeAgents.delete(threadId);
      this.threadManager.updateThread(threadId, {
        status: 'failed',
        completedAt: new Date().toISOString()
      });
      this.emitWS(threadId, 'agent:error', {
        error: err.message || 'Failed to start Claude CLI process'
      });
      this.emitWS(threadId, 'agent:status', { status: 'failed' });
      throw err;
    }
  }

  async stopAgent(threadId: string): Promise<void> {
    const claudeProcess = this.state.activeAgents.get(threadId);
    if (claudeProcess) {
      this.state.manuallyStopped.add(threadId);
      try {
        await claudeProcess.kill();
      } catch (e) {
        console.error(`[agent] Error killing process for thread ${threadId}:`, e);
      }
      this.state.activeAgents.delete(threadId);
    }

    this.threadManager.updateThread(threadId, { status: 'stopped', completedAt: new Date().toISOString() });
    this.emitWS(threadId, 'agent:status', { status: 'stopped' });
  }

  isAgentRunning(threadId: string): boolean {
    return this.state.activeAgents.has(threadId);
  }

  /**
   * Clean up all in-memory state for a thread.
   * Call when deleting/archiving a thread.
   */
  cleanupThreadState(threadId: string): void {
    this.state.cleanupThread(threadId);
  }

  /**
   * Kill all active agent processes. Called during server shutdown.
   */
  async stopAllAgents(): Promise<void> {
    const entries = [...this.state.activeAgents.entries()];
    if (entries.length === 0) return;
    console.log(`[agent] Stopping ${entries.length} active agent(s)...`);
    await Promise.allSettled(
      entries.map(async ([threadId, proc]) => {
        try {
          await proc.kill();
        } catch (e) {
          console.error(`[agent] Error killing agent for thread ${threadId}:`, e);
        }
        this.state.activeAgents.delete(threadId);
      })
    );
    console.log('[agent] All agents stopped.');
  }

  // ── Private helpers ────────────────────────────────────────────

  /**
   * Try to resume an active session by injecting the user's answer
   * into the pending can_use_tool request.
   * Returns true if resume was successful and no restart is needed.
   */
  private tryResumeWithUserInput(
    threadId: string,
    prompt: string,
    model: ClaudeModel,
    permissionMode: PermissionMode,
    images?: any[],
  ): boolean {
    const waitingReason = this.state.pendingUserInput.get(threadId);
    const hasPendingCanUseTool = this.state.pendingCanUseTool.has(threadId);

    if (!(waitingReason === 'question' || waitingReason === 'permission' || waitingReason === 'plan' || hasPendingCanUseTool)) {
      return false;
    }

    console.log(`[agent] Resuming existing thread=${threadId} with user input`);

    // Save user message to DB
    this.threadManager.insertMessage({
      threadId,
      role: 'user',
      content: prompt,
      images: images ? JSON.stringify(images) : null,
      model,
      permissionMode,
    });

    // Respond to the stored can_use_tool request with the user's answer
    const pending = this.state.pendingCanUseTool.get(threadId);
    if (pending) {
      console.log(`[agent] Responding to can_use_tool with user answer for thread=${threadId}`);

      const updatedInput = {
        ...pending.input,
        result: prompt,
      };

      const response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: pending.requestId,
          response: { behavior: 'allow', updatedInput }
        }
      };
      pending.process.sendControlResponse(response);

      this.state.pendingUserInput.delete(threadId);
      this.state.lastToolUseId.delete(threadId);
      this.state.pendingCanUseTool.delete(threadId);
      this.emitWS(threadId, 'agent:status', { status: 'running' });
      return true;
    }

    console.warn(`[agent] Could not find toolUseId for resume, falling back to restart`);
    return false;
  }
}

// ── Default singleton (backward-compatible exports) ─────────────

const defaultRunner = new AgentRunner(
  tm,
  wsBroker,
  { create: (opts: ClaudeProcessOptions) => new ClaudeProcess(opts) },
);

export const startAgent = defaultRunner.startAgent.bind(defaultRunner);
export const stopAgent = defaultRunner.stopAgent.bind(defaultRunner);
export const stopAllAgents = defaultRunner.stopAllAgents.bind(defaultRunner);
export const isAgentRunning = defaultRunner.isAgentRunning.bind(defaultRunner);
export const cleanupThreadState = defaultRunner.cleanupThreadState.bind(defaultRunner);
