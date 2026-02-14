import type { IThreadManager, IWSBroker } from './interfaces.js';
import type { CLIMessage } from './claude-process.js';
import type { WSEvent } from '@a-parallel/shared';
import type { AgentStateTracker } from './agent-state.js';
import * as pm from './project-manager.js';
import { getStatusSummary, deriveGitSyncState } from '../utils/git-v2.js';

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

/**
 * Handles all CLI messages from Claude processes — system init,
 * assistant text/tool_use, user tool_result, and result.
 */
export class AgentMessageHandler {
  constructor(
    private state: AgentStateTracker,
    private threadManager: IThreadManager,
    private wsBroker: IWSBroker,
  ) {}

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

  handle(threadId: string, msg: CLIMessage): void {
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
      this.handleAssistantMessage(threadId, msg);
      return;
    }

    // User messages — tool results (output from tool executions)
    if (msg.type === 'user') {
      this.handleToolResults(threadId, msg);
      return;
    }

    // Result — agent finished
    if (msg.type === 'result') {
      this.handleResult(threadId, msg);
    }
  }

  // ── Assistant message handling ─────────────────────────────────

  private handleAssistantMessage(threadId: string, msg: CLIMessage & { type: 'assistant' }): void {
    const cliMsgId = msg.message.id;

    // Get or init the CLI→DB message ID map for this thread
    const cliMap = this.state.cliToDbMsgId.get(threadId) ?? new Map<string, string>();
    this.state.cliToDbMsgId.set(threadId, cliMap);

    // Combine all text blocks into a single string
    const textContent = decodeUnicodeEscapes(
      msg.message.content
        .filter((b): b is { type: 'text'; text: string } => 'text' in b && !!b.text)
        .map((b) => b.text)
        .join('\n\n')
    );

    if (textContent) {
      let msgId = this.state.currentAssistantMsgId.get(threadId) || cliMap.get(cliMsgId);
      if (msgId) {
        this.threadManager.updateMessage(msgId, textContent);
      } else {
        msgId = this.threadManager.insertMessage({ threadId, role: 'assistant', content: textContent });
      }
      this.state.currentAssistantMsgId.set(threadId, msgId);
      cliMap.set(cliMsgId, msgId);

      this.emitWS(threadId, 'agent:message', {
        messageId: msgId,
        role: 'assistant',
        content: textContent,
      });
    }

    // Handle tool calls (deduplicate — streaming sends cumulative content)
    const seen = this.state.processedToolUseIds.get(threadId) ?? new Map<string, string>();
    for (const block of msg.message.content) {
      if ('type' in block && block.type === 'tool_use') {
        if (seen.has(block.id)) {
          this.state.currentAssistantMsgId.delete(threadId);
          continue;
        }

        // Skip duplicate ExitPlanMode calls
        if (block.name === 'ExitPlanMode' && this.state.pendingUserInput.get(threadId) === 'plan') {
          console.log(`[agent] Skipping duplicate ExitPlanMode for thread=${threadId}`);
          seen.set(block.id, 'skipped');
          continue;
        }

        console.log(`[agent] tool_use: ${block.name} thread=${threadId}`);
        console.log(`[agent] tool_use input:`, JSON.stringify(block.input, null, 2));

        // Ensure there's always a parent assistant message for tool calls
        let parentMsgId = this.state.currentAssistantMsgId.get(threadId) || cliMap.get(cliMsgId);
        if (!parentMsgId) {
          parentMsgId = this.threadManager.insertMessage({ threadId, role: 'assistant', content: '' });
          this.emitWS(threadId, 'agent:message', {
            messageId: parentMsgId,
            role: 'assistant',
            content: '',
          });
        }
        this.state.currentAssistantMsgId.set(threadId, parentMsgId);
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
          this.state.pendingUserInput.set(threadId, 'question');
          this.state.lastToolUseId.set(threadId, block.id);
          this.threadManager.updateThread(threadId, { status: 'waiting' });
          this.emitWS(threadId, 'agent:status', { status: 'waiting', waitingReason: 'question' });
        } else if (block.name === 'ExitPlanMode') {
          this.state.pendingUserInput.set(threadId, 'plan');
          this.threadManager.updateThread(threadId, { status: 'waiting' });
          this.emitWS(threadId, 'agent:status', { status: 'waiting', waitingReason: 'plan' });
        } else {
          this.state.pendingUserInput.delete(threadId);
        }

        // Reset currentAssistantMsgId — next CLI message's text should be a new DB message
        this.state.currentAssistantMsgId.delete(threadId);
      }
    }
    this.state.processedToolUseIds.set(threadId, seen);
  }

  // ── Tool result handling ───────────────────────────────────────

  private handleToolResults(threadId: string, msg: CLIMessage & { type: 'user' }): void {
    const seen = this.state.processedToolUseIds.get(threadId);
    if (!seen || !msg.message.content) return;

    for (const block of msg.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const toolCallId = seen.get(block.tool_use_id);
        if (toolCallId && block.content) {
          const decodedOutput = decodeUnicodeEscapes(block.content);

          console.log(`[agent] tool_result: toolCallId=${toolCallId} thread=${threadId}`);
          console.log(`[agent] tool_result output (${decodedOutput.length} chars):`, decodedOutput);

          this.threadManager.updateToolCallOutput(toolCallId, decodedOutput);
          this.emitWS(threadId, 'agent:tool_output', {
            toolCallId,
            output: decodedOutput,
          });

          // Detect permission denial pattern
          const permissionDeniedMatch = decodedOutput.match(
            /(?:requested permissions? to use|hasn't been granted|hasn't granted|permission.*denied|not in the allowed tools list)/i
          );

          if (permissionDeniedMatch) {
            const tc = this.threadManager.getToolCall(toolCallId);
            if (tc?.name) {
              console.log(`[agent] permission denied detected: tool=${tc.name} thread=${threadId}`);
              this.state.pendingPermissionRequest.set(threadId, {
                toolName: tc.name,
                toolUseId: block.tool_use_id,
              });
            }
          }
        }
      }
    }
  }

  // ── Result handling ────────────────────────────────────────────

  private handleResult(threadId: string, msg: CLIMessage & { type: 'result' }): void {
    if (this.state.resultReceived.has(threadId)) return;

    console.log(`[agent] result thread=${threadId} status=${msg.subtype} cost=$${msg.total_cost_usd} duration=${msg.duration_ms}ms`);
    this.state.resultReceived.add(threadId);
    this.state.currentAssistantMsgId.delete(threadId);

    let waitingReason = this.state.pendingUserInput.get(threadId);
    const permReq = this.state.pendingPermissionRequest.get(threadId);

    if (!waitingReason && permReq) {
      waitingReason = 'permission';
    }

    const isWaitingForUser = !!waitingReason;
    const finalStatus = isWaitingForUser
      ? 'waiting'
      : msg.subtype === 'success' ? 'completed' : 'failed';
    this.state.pendingUserInput.delete(threadId);

    this.threadManager.updateThread(threadId, {
      status: finalStatus,
      cost: msg.total_cost_usd,
      ...(finalStatus !== 'waiting' ? { completedAt: new Date().toISOString() } : {}),
    });

    // Auto-transition stage to 'review' when agent completes/fails
    if (finalStatus !== 'waiting') {
      const threadForStage = this.threadManager.getThread(threadId);
      if (threadForStage && threadForStage.stage === 'in_progress') {
        this.threadManager.updateThread(threadId, { stage: 'review' });
      }
    }

    const threadWithStage = this.threadManager.getThread(threadId);

    this.emitWS(threadId, 'agent:result', {
      result: msg.result ? decodeUnicodeEscapes(msg.result) : msg.result,
      cost: msg.total_cost_usd,
      duration: msg.duration_ms,
      status: finalStatus,
      stage: threadWithStage?.stage,
      ...(finalStatus === 'failed' ? { errorReason: msg.subtype } : {}),
      ...(waitingReason ? { waitingReason } : {}),
      ...(permReq ? { permissionRequest: { toolName: permReq.toolName } } : {}),
    });

    if (permReq) {
      this.state.pendingPermissionRequest.delete(threadId);
    }

    // Emit git status for worktree threads (async, non-blocking)
    this.emitGitStatus(threadId).catch(() => {});
  }

  // ── Git status emission ────────────────────────────────────────

  async emitGitStatus(threadId: string): Promise<void> {
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
}
