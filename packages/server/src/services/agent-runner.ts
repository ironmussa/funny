import { wsBroker } from './ws-broker.js';
import * as tm from './thread-manager.js';
import * as pm from './project-manager.js';
import type { WSEvent, ClaudeModel, PermissionMode, WaitingReason } from '@a-parallel/shared';
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
import { getStatusSummary, deriveGitSyncState } from '../utils/git-v2.js';

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

/**
 * Decode literal Unicode escape sequences (\uXXXX) that may appear
 * in CLI output when the text was double-encoded or the CLI emits
 * escaped Unicode instead of raw UTF-8 characters.
 */
function decodeUnicodeEscapes(str: string): string {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

// ── AgentRunner class ───────────────────────────────────────────

export class AgentRunner {
  // Active running agents (in-memory only)
  private activeAgents = new Map<string, IClaudeProcess>();

  // Track whether we received a result message before the process exited
  private resultReceived = new Set<string>();

  // Track threads that were manually stopped
  private manuallyStopped = new Set<string>();

  // Track the current assistant message DB ID per thread
  private currentAssistantMsgId = new Map<string, string>();

  // Track tool_use block IDs that have already been processed per thread
  // Maps threadId → (cliToolUseId → our toolCallId)
  private processedToolUseIds = new Map<string, Map<string, string>>();

  // Map CLI message IDs to our DB message IDs per thread
  // Maps threadId → (cliMessageId → dbMessageId)
  private cliToDbMsgId = new Map<string, Map<string, string>>();

  // Track threads where the last tool call was AskUserQuestion or ExitPlanMode
  private pendingUserInput = new Map<string, WaitingReason>();

  // Track pending permission requests per thread
  private pendingPermissionRequest = new Map<string, { toolName: string; toolUseId: string }>();

  // Track the ID of the last tool use (specifically for AskUserQuestion) to enable resuming
  private lastToolUseId = new Map<string, string>();

  // Store pending can_use_tool requests for AskUserQuestion so we can respond with the user's answer later
  private pendingCanUseTool = new Map<string, { requestId: string; process: IClaudeProcess; input: any }>();

  constructor(
    private threadManager: IThreadManager,
    private wsBroker: IWSBroker,
    private processFactory: IClaudeProcessFactory,
  ) { }

  private emitWS(threadId: string, type: WSEvent['type'], data: unknown): void {
    const event = { type, threadId, data } as WSEvent;
    // Look up thread's userId for per-user filtering
    const thread = this.threadManager.getThread(threadId);
    const userId = thread?.userId;
    if (userId) {
      this.wsBroker.emitToUser(userId, event);
    } else {
      this.wsBroker.emit(event);
    }
  }

  // ── Message handler ──────────────────────────────────────────

  handleCLIMessage(threadId: string, msg: CLIMessage): void {
    // System init — capture session ID and broadcast init info
    if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
      console.log(`[agent] init session=${msg.session_id} thread=${threadId}`);
      this.threadManager.updateThread(threadId, { sessionId: msg.session_id });

      this.emitWS(threadId, 'agent:init', {
        tools: msg.tools ?? [],
        cwd: msg.cwd ?? '',
        model: msg.model ?? '',
      });
      return;
    }

    // Assistant messages — text and tool calls
    if (msg.type === 'assistant') {
      const cliMsgId = msg.message.id; // stable across cumulative streaming updates

      // Get or init the CLI→DB message ID map for this thread
      const cliMap = this.cliToDbMsgId.get(threadId) ?? new Map<string, string>();
      this.cliToDbMsgId.set(threadId, cliMap);

      // Combine all text blocks into a single string
      const textContent = decodeUnicodeEscapes(
        msg.message.content
          .filter((b): b is { type: 'text'; text: string } => 'text' in b && !!b.text)
          .map((b) => b.text)
          .join('\n\n')
      );

      if (textContent) {
        // Reuse existing DB message: first check currentAssistantMsgId, then CLI map
        let msgId = this.currentAssistantMsgId.get(threadId) || cliMap.get(cliMsgId);
        if (msgId) {
          // Update existing row (streaming update — same turn, fuller content)
          this.threadManager.updateMessage(msgId, textContent);
        } else {
          // First text for this turn — insert new row
          msgId = this.threadManager.insertMessage({ threadId, role: 'assistant', content: textContent });
        }
        this.currentAssistantMsgId.set(threadId, msgId);
        cliMap.set(cliMsgId, msgId);

        this.emitWS(threadId, 'agent:message', {
          messageId: msgId,
          role: 'assistant',
          content: textContent,
        });
      }

      // Handle tool calls (deduplicate — streaming sends cumulative content)
      const seen = this.processedToolUseIds.get(threadId) ?? new Map<string, string>();
      for (const block of msg.message.content) {
        if ('type' in block && block.type === 'tool_use') {
          if (seen.has(block.id)) {
            // Already processed — still reset currentAssistantMsgId so the
            // next CLI message creates a new DB row instead of appending here
            this.currentAssistantMsgId.delete(threadId);
            continue;
          }

          // Claude Code sometimes calls ExitPlanMode twice with the same plan content.
          // Skip the duplicate if we already have a pending plan for this thread.
          if (block.name === 'ExitPlanMode' && this.pendingUserInput.get(threadId) === 'plan') {
            console.log(`[agent] Skipping duplicate ExitPlanMode for thread=${threadId}`);
            seen.set(block.id, 'skipped');
            continue;
          }

          console.log(`[agent] tool_use: ${block.name} thread=${threadId}`);
          console.log(`[agent] tool_use input:`, JSON.stringify(block.input, null, 2));

          // Ensure there's always a parent assistant message for tool calls
          let parentMsgId = this.currentAssistantMsgId.get(threadId) || cliMap.get(cliMsgId);
          if (!parentMsgId) {
            parentMsgId = this.threadManager.insertMessage({ threadId, role: 'assistant', content: '' });
            // Notify client so it creates the message before tool calls arrive
            this.emitWS(threadId, 'agent:message', {
              messageId: parentMsgId,
              role: 'assistant',
              content: '',
            });
          }
          this.currentAssistantMsgId.set(threadId, parentMsgId);
          cliMap.set(cliMsgId, parentMsgId);

          // Check DB for existing duplicate (guards against session resume re-sending old tool_use blocks)
          const inputJson = JSON.stringify(block.input);
          const existingTC = this.threadManager.findToolCall(parentMsgId, block.name, inputJson);

          if (existingTC) {
            seen.set(block.id, existingTC.id);
          } else {
            const toolCallId = this.threadManager.insertToolCall({
              messageId: parentMsgId,
              name: block.name,
              input: inputJson,
            });
            seen.set(block.id, toolCallId);

            this.emitWS(threadId, 'agent:tool_call', {
              toolCallId,
              messageId: parentMsgId,
              name: block.name,
              input: block.input,
            });
          }

          // Track if this tool call means Claude is waiting for user input
          if (block.name === 'AskUserQuestion') {
            this.pendingUserInput.set(threadId, 'question');
            this.lastToolUseId.set(threadId, block.id);
            // Immediately transition to 'waiting' so the UI shows the question state
            // right away — don't wait for the can_use_tool control request
            this.threadManager.updateThread(threadId, { status: 'waiting' });
            this.emitWS(threadId, 'agent:status', { status: 'waiting', waitingReason: 'question' });
          } else if (block.name === 'ExitPlanMode') {
            this.pendingUserInput.set(threadId, 'plan');
            this.threadManager.updateThread(threadId, { status: 'waiting' });
            this.emitWS(threadId, 'agent:status', { status: 'waiting', waitingReason: 'plan' });
          } else {
            this.pendingUserInput.delete(threadId);
          }

          // Reset currentAssistantMsgId — next CLI message's text should be a new DB message
          // But cliMap keeps the mapping so cumulative updates of THIS message still work
          this.currentAssistantMsgId.delete(threadId);
        }
      }
      this.processedToolUseIds.set(threadId, seen);
      return;
    }

    // User messages — tool results (output from tool executions)
    if (msg.type === 'user') {
      const seen = this.processedToolUseIds.get(threadId);
      if (seen && msg.message.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const toolCallId = seen.get(block.tool_use_id);
            if (toolCallId && block.content) {
              // Update DB
              const decodedOutput = decodeUnicodeEscapes(block.content);

              // Log the complete tool result output
              console.log(`[agent] tool_result: toolCallId=${toolCallId} thread=${threadId}`);
              console.log(`[agent] tool_result output (${decodedOutput.length} chars):`, decodedOutput);

              this.threadManager.updateToolCallOutput(toolCallId, decodedOutput);
              // Notify clients
              this.emitWS(threadId, 'agent:tool_output', {
                toolCallId,
                output: decodedOutput,
              });

              // Detect permission denial pattern
              const permissionDeniedMatch = decodedOutput.match(
                /(?:requested permissions? to use|hasn't been granted|hasn't granted|permission.*denied|not in the allowed tools list)/i
              );

              if (permissionDeniedMatch) {
                // Extract the tool name from the DB
                const tc = this.threadManager.getToolCall(toolCallId);
                if (tc?.name) {
                  console.log(`[agent] permission denied detected: tool=${tc.name} thread=${threadId}`);
                  this.pendingPermissionRequest.set(threadId, {
                    toolName: tc.name,
                    toolUseId: block.tool_use_id,
                  });
                }
              }
            }
          }
        }
      }
      return;
    }

    // Result — agent finished (deduplicate: CLI may send result more than once)
    if (msg.type === 'result') {
      if (this.resultReceived.has(threadId)) return;

      console.log(`[agent] result thread=${threadId} status=${msg.subtype} cost=$${msg.total_cost_usd} duration=${msg.duration_ms}ms`);
      this.resultReceived.add(threadId);
      this.currentAssistantMsgId.delete(threadId);
      // NOTE: processedToolUseIds preserved to deduplicate on next session resume

      // If the last tool call was AskUserQuestion or ExitPlanMode, Claude is
      // waiting for user input — use 'waiting' instead of 'completed'.
      let waitingReason = this.pendingUserInput.get(threadId);
      const permReq = this.pendingPermissionRequest.get(threadId);

      // If no other waiting reason but we have a permission request, set waiting reason
      if (!waitingReason && permReq) {
        waitingReason = 'permission';
      }

      const isWaitingForUser = !!waitingReason;
      const finalStatus = isWaitingForUser
        ? 'waiting'
        : msg.subtype === 'success' ? 'completed' : 'failed';
      this.pendingUserInput.delete(threadId);

      this.threadManager.updateThread(threadId, {
        status: finalStatus,
        cost: msg.total_cost_usd,
        // Only set completedAt for truly terminal states
        ...(finalStatus !== 'waiting' ? { completedAt: new Date().toISOString() } : {}),
      });

      // Auto-transition stage to 'review' when agent completes/fails
      if (finalStatus !== 'waiting') {
        const threadForStage = this.threadManager.getThread(threadId);
        if (threadForStage && threadForStage.stage === 'in_progress') {
          this.threadManager.updateThread(threadId, { stage: 'review' });
        }
      }

      // Get the updated thread to include the current stage in WebSocket event
      const threadWithStage = this.threadManager.getThread(threadId);

      // Emit agent:result which already contains the final status.
      this.emitWS(threadId, 'agent:result', {
        result: msg.result ? decodeUnicodeEscapes(msg.result) : msg.result,
        cost: msg.total_cost_usd,
        duration: msg.duration_ms,
        status: finalStatus,
        stage: threadWithStage?.stage,
        ...(waitingReason ? { waitingReason } : {}),
        ...(permReq ? { permissionRequest: { toolName: permReq.toolName } } : {}),
      });

      // Clear permission request after emitting (don't delete before emit!)
      if (permReq) {
        this.pendingPermissionRequest.delete(threadId);
      }

      // Emit git status for worktree threads (async, non-blocking)
      this.emitGitStatus(threadId).catch(() => { });
    }
  }

  // ── Control Protocol Handler ───────────────────────────────────

  handleControlRequest(threadId: string, msg: any, process: IClaudeProcess): void {
    const subtype = msg.request?.subtype;

    // Handle hook_callback for tool approval
    if (subtype === 'hook_callback' && msg.request.callback_id === 'tool_approval') {
      const toolName = msg.request.input?.tool_name || msg.request.input?.tool || 'Unknown';
      console.log(`[agent] hook_callback tool_approval: ${toolName} thread=${threadId}`);

      // If AskUserQuestion or ExitPlanMode, we PAUSE and ask user.
      if (toolName === 'AskUserQuestion') {
        console.log(`[agent] Intercepted AskUserQuestion - pausing for user input`);
        this.pendingUserInput.set(threadId, 'question');
        const toolUseId = msg.request.input?.tool_use_id;
        if (toolUseId) {
          this.lastToolUseId.set(threadId, toolUseId);
        }
      } else if (toolName === 'ExitPlanMode') {
        console.log(`[agent] Intercepted ExitPlanMode - pausing for user input`);
        this.pendingUserInput.set(threadId, 'plan');
        const toolUseId = msg.request.input?.tool_use_id;
        if (toolUseId) {
          this.lastToolUseId.set(threadId, toolUseId);
        }
      }

      // Always ALLOW the tool
      const response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: { behavior: 'allow' }
        }
      };
      process.sendControlResponse(response);
      return;
    }

    // Handle can_use_tool requests (permission check)
    if (subtype === 'can_use_tool') {
      const toolName = msg.request.tool_name || 'Unknown';
      console.log(`[agent] can_use_tool: ${toolName} thread=${threadId}`);

      // For AskUserQuestion or ExitPlanMode, DON'T respond yet — wait for the user's answer
      if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
        console.log(`[agent] Holding can_use_tool for ${toolName} — waiting for user answer`);
        this.pendingCanUseTool.set(threadId, {
          requestId: msg.request_id,
          process,
          input: msg.request.input,
        });

        // Immediately transition to 'waiting' so the UI stops showing "Agent is working..."
        const waitingReason = this.pendingUserInput.get(threadId) ?? (toolName === 'ExitPlanMode' ? 'plan' : 'question');
        this.threadManager.updateThread(threadId, { status: 'waiting' });
        this.emitWS(threadId, 'agent:status', { status: 'waiting', waitingReason });
        return;
      }

      // For all other tools, allow immediately
      const response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: { behavior: 'allow', updatedInput: msg.request.input }
        }
      };
      process.sendControlResponse(response);
      return;
    }

    // Unhandled request type - log for debugging
    console.log(`[agent] Unhandled control request subtype=${subtype} thread=${threadId}`);
  }

  // ── Git status emission ────────────────────────────────────────

  private async emitGitStatus(threadId: string): Promise<void> {
    const thread = this.threadManager.getThread(threadId);
    if (!thread?.worktreePath || thread.mode !== 'worktree') return;

    const project = pm.getProject(thread.projectId);
    if (!project) return;

    const summaryResult = await getStatusSummary(
      thread.worktreePath,
      thread.baseBranch ?? undefined,
      project.path
    );
    if (summaryResult.isErr()) return;
    const summary = summaryResult.value;

    this.emitWS(threadId, 'git:status', {
      statuses: [{
        threadId,
        state: deriveGitSyncState(summary),
        ...summary,
      }],
    });
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

    // Check if we're resuming an existing active session (e.g. user answering a question or providing feedback)
    const existing = this.activeAgents.get(threadId);
    if (existing && !existing.exited) {
      const waitingReason = this.pendingUserInput.get(threadId);
      const hasPendingCanUseTool = this.pendingCanUseTool.has(threadId);

      // If we are waiting for a question answer, this prompt IS the answer.
      // Also check pendingCanUseTool directly — the result handler may have cleared
      // pendingUserInput while can_use_tool is still being held.
      if (waitingReason === 'question' || waitingReason === 'permission' || waitingReason === 'plan' || hasPendingCanUseTool) {
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
        const pending = this.pendingCanUseTool.get(threadId);
        if (pending) {
          console.log(`[agent] Responding to can_use_tool with user answer for thread=${threadId}`);

          // Inject the user's answer into the original question input
          const updatedInput = {
            ...pending.input,
            result: prompt, // The user's answer text
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

          // Clear all waiting state
          this.pendingUserInput.delete(threadId);
          this.lastToolUseId.delete(threadId);
          this.pendingCanUseTool.delete(threadId);
          this.emitWS(threadId, 'agent:status', { status: 'running' });
          return; // Do NOT kill the process!
        }

        // If we can't find the toolUseId, fall through to restart (last resort)
        console.warn(`[agent] Could not find toolUseId for resume, falling back to restart`);
      }

      // Explicitly STOP if we are restarting and it's not a resume flow
      console.log(`[agent] stopping existing agent for thread=${threadId} before restart`);
      this.manuallyStopped.add(threadId);
      try { await existing.kill(); } catch { /* best-effort */ }
      this.activeAgents.delete(threadId);
    }

    // Clear stale state from previous runs.
    // NOTE: processedToolUseIds and cliToDbMsgId are intentionally preserved
    // across sessions to deduplicate re-sent content on session resume (--resume).
    this.currentAssistantMsgId.delete(threadId);
    this.resultReceived.delete(threadId);
    this.manuallyStopped.delete(threadId);
    this.pendingUserInput.delete(threadId);

    // Update thread status
    this.threadManager.updateThread(threadId, { status: 'running' });

    // Auto-transition stage to 'in_progress' from 'backlog' or 'review'.
    // 'done' is a user-assigned stage and should be preserved.
    const currentThread = this.threadManager.getThread(threadId);
    if (currentThread && (currentThread.stage === 'review' || currentThread.stage === 'backlog')) {
      this.threadManager.updateThread(threadId, { stage: 'in_progress' });
    }

    // Get the updated thread to include the current stage in WebSocket event
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

    // When resuming a session, add context to prevent Claude from re-planning.
    // Without this, Claude sees plan mode in its conversation history and starts
    // planning again instead of continuing execution.
    let effectivePrompt = prompt;
    if (isResume) {
      console.log(`[agent] Resuming session=${thread!.sessionId} for thread=${threadId}`);
      effectivePrompt = `[SYSTEM NOTE: This is a session resume after an interruption. Your previous session was interrupted mid-execution. Continue from where you left off. Do NOT re-plan or start over — pick up execution from the last completed step.]\n\n${prompt}`;
    }

    // When resuming, override 'plan' permission mode to 'acceptEdits'.
    // The CLI's --permission-mode plan flag forces Claude back into planning mode
    // even on resume. By switching to 'acceptEdits', Claude gets full edit
    // permissions and continues execution instead of re-planning.
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
      maxTurns: 30,
      sessionId: thread?.sessionId ?? undefined,
      images,
    });

    this.activeAgents.set(threadId, claudeProcess);
    this.resultReceived.delete(threadId);

    // Handle messages from the CLI
    claudeProcess.on('message', (msg: CLIMessage) => {
      this.handleCLIMessage(threadId, msg);
    });

    // Handle Control Requests (hooks, permissions)
    claudeProcess.on('control_request', (msg: any) => {
      this.handleControlRequest(threadId, msg, claudeProcess);
    });

    // Handle errors
    claudeProcess.on('error', (err: Error) => {
      console.error(`[agent] Error in thread ${threadId}:`, err);

      // Don't overwrite status if manually stopped or result already received
      if (!this.resultReceived.has(threadId) && !this.manuallyStopped.has(threadId)) {
        this.threadManager.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });

        this.emitWS(threadId, 'agent:error', { error: err.message });
        this.emitWS(threadId, 'agent:status', { status: 'failed' });
      }
    });

    // Handle process exit
    claudeProcess.on('exit', (code: number | null) => {
      this.activeAgents.delete(threadId);

      // If manually stopped, don't overwrite the 'stopped' status
      if (this.manuallyStopped.has(threadId)) {
        this.manuallyStopped.delete(threadId);
        this.resultReceived.delete(threadId);
        return;
      }

      // If the process exited without sending a result, mark as failed
      if (!this.resultReceived.has(threadId)) {
        this.threadManager.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });

        this.emitWS(threadId, 'agent:error', {
          error: 'Agent process exited unexpectedly without a result',
        });
        this.emitWS(threadId, 'agent:status', { status: 'failed' });
      }

      this.resultReceived.delete(threadId);
    });

    // Start the process (this may throw if Claude CLI is not installed)
    try {
      claudeProcess.start();
    } catch (err: any) {
      // If Claude CLI is not installed, fail immediately with a clear error
      console.error(`[agent] Failed to start Claude process for thread=${threadId}:`, err.message);

      // Clean up
      this.activeAgents.delete(threadId);
      this.threadManager.updateThread(threadId, {
        status: 'failed',
        completedAt: new Date().toISOString()
      });

      // Notify client
      this.emitWS(threadId, 'agent:error', {
        error: err.message || 'Failed to start Claude CLI process'
      });
      this.emitWS(threadId, 'agent:status', { status: 'failed' });

      // Re-throw so the route handler can catch it
      throw err;
    }
  }

  async stopAgent(threadId: string): Promise<void> {
    const claudeProcess = this.activeAgents.get(threadId);
    if (claudeProcess) {
      this.manuallyStopped.add(threadId);
      try {
        await claudeProcess.kill();
      } catch (e) {
        console.error(`[agent] Error killing process for thread ${threadId}:`, e);
      }
      this.activeAgents.delete(threadId);
    }

    this.threadManager.updateThread(threadId, { status: 'stopped', completedAt: new Date().toISOString() });

    this.emitWS(threadId, 'agent:status', { status: 'stopped' });
  }

  isAgentRunning(threadId: string): boolean {
    return this.activeAgents.has(threadId);
  }

  /**
   * Clean up all in-memory state for a thread.
   * Call when deleting/archiving a thread.
   */
  /**
   * Kill all active agent processes. Called during server shutdown.
   */
  async stopAllAgents(): Promise<void> {
    const entries = [...this.activeAgents.entries()];
    if (entries.length === 0) return;
    console.log(`[agent] Stopping ${entries.length} active agent(s)...`);
    await Promise.allSettled(
      entries.map(async ([threadId, proc]) => {
        try {
          await proc.kill();
        } catch (e) {
          console.error(`[agent] Error killing agent for thread ${threadId}:`, e);
        }
        this.activeAgents.delete(threadId);
      })
    );
    console.log('[agent] All agents stopped.');
  }

  cleanupThreadState(threadId: string): void {
    this.activeAgents.delete(threadId);
    this.resultReceived.delete(threadId);
    this.manuallyStopped.delete(threadId);
    this.currentAssistantMsgId.delete(threadId);
    this.processedToolUseIds.delete(threadId);
    this.cliToDbMsgId.delete(threadId);
    this.pendingUserInput.delete(threadId);
    this.pendingPermissionRequest.delete(threadId);
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
