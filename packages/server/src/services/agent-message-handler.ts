/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain emits: agent:message, agent:tool_call, agent:tool_output, agent:result, agent:status, git:changed, thread:stage-changed
 * @domain depends: AgentStateTracker, ThreadManager, WSBroker, ThreadEventBus
 */

import type { CLIMessage } from '@funny/core/agents';
import { getStatusSummary, deriveGitSyncState } from '@funny/core/git';
import type { WSEvent, ThreadStatus } from '@funny/shared';

import { log } from '../lib/logger.js';
import type { AgentStateTracker } from './agent-state.js';
import type { IThreadManager, IWSBroker } from './server-interfaces.js';
import { threadEventBus } from './thread-event-bus.js';
import { saveThreadEvent } from './thread-event-service.js';
import { transitionStatus } from './thread-status-machine.js';

/**
 * Decode literal Unicode escape sequences (\uXXXX) that may appear
 * in CLI output when the text was double-encoded or the CLI emits
 * escaped Unicode instead of raw UTF-8 characters.
 */
function decodeUnicodeEscapes(str: string): string {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Handles all CLI messages from Claude processes — system init,
 * assistant text/tool_use, user tool_result, and result.
 */
export type ProjectLookup = (id: string) => { path: string; [key: string]: any } | undefined;

export class AgentMessageHandler {
  private _getProject: ProjectLookup | undefined;

  constructor(
    private state: AgentStateTracker,
    private threadManager: IThreadManager,
    private wsBroker: IWSBroker,
    getProject?: ProjectLookup,
  ) {
    this._getProject = getProject;
  }

  /** Lazy-load project-manager to avoid importing the singleton DB in tests */
  private async getProject(id: string): Promise<{ path: string; [key: string]: any } | undefined> {
    if (!this._getProject) {
      const pm = require('./project-manager.js');
      this._getProject = pm.getProject;
    }
    return this._getProject!(id);
  }

  /** Build common log attributes with thread context for observability */
  private async threadCtx(threadId: string): Promise<Record<string, string>> {
    const thread = await this.threadManager.getThread(threadId);
    return {
      namespace: 'agent',
      threadId,
      userId: thread?.userId ?? 'unknown',
      projectId: thread?.projectId ?? 'unknown',
      threadStatus: thread?.status ?? 'unknown',
      sessionId: thread?.sessionId ?? '',
    };
  }

  private async emitWS(threadId: string, type: WSEvent['type'], data: unknown): Promise<void> {
    const event = { type, threadId, data } as WSEvent;
    const thread = await this.threadManager.getThread(threadId);
    const userId = thread?.userId;
    if (userId) {
      this.wsBroker.emitToUser(userId, event);
    } else {
      this.wsBroker.emit(event);
    }
  }

  async handle(threadId: string, msg: CLIMessage): Promise<void> {
    log.debug('handle() raw message', {
      ...(await this.threadCtx(threadId)),
      type: msg.type,
      subtype: (msg as any).subtype,
    });

    // System init — capture session ID and broadcast init info
    if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
      log.info('Session initialized', {
        ...(await this.threadCtx(threadId)),
        sessionId: msg.session_id,
      });
      await this.threadManager.updateThread(threadId, {
        sessionId: msg.session_id,
        initTools: JSON.stringify(msg.tools ?? []),
        initCwd: msg.cwd ?? '',
      });

      await this.emitWS(threadId, 'agent:init', {
        tools: msg.tools ?? [],
        cwd: msg.cwd ?? '',
        model: msg.model ?? '',
      });
      return;
    }

    // Assistant messages — text and tool calls
    if (msg.type === 'assistant') {
      await this.handleAssistantMessage(threadId, msg);
      return;
    }

    // User messages — tool results (output from tool executions)
    if (msg.type === 'user') {
      await this.handleToolResults(threadId, msg);
      return;
    }

    // Compact boundary — context window was compacted
    if (msg.type === 'compact_boundary') {
      const timestamp = new Date().toISOString();
      log.info('Context compacted', {
        ...(await this.threadCtx(threadId)),
        trigger: msg.trigger,
        preTokens: String(msg.preTokens),
        timestamp,
      });
      this.state.cumulativeInputTokens.set(threadId, 0);
      await this.emitWS(threadId, 'agent:compact_boundary', {
        trigger: msg.trigger,
        preTokens: msg.preTokens,
        timestamp,
      });

      // Persist to thread_events so it survives page refreshes
      saveThreadEvent(threadId, 'compact_boundary', {
        trigger: msg.trigger,
        preTokens: msg.preTokens,
        timestamp,
      }).catch((err) => {
        log.error('Failed to persist compact_boundary event', {
          namespace: 'agent',
          threadId,
          error: err,
        });
      });
      return;
    }

    // Result — agent finished
    if (msg.type === 'result') {
      await this.handleResult(threadId, msg);
    }
  }

  // ── Assistant message handling ─────────────────────────────────

  private async handleAssistantMessage(
    threadId: string,
    msg: CLIMessage & { type: 'assistant' },
  ): Promise<void> {
    const cliMsgId = msg.message.id;

    // Get or init the CLI→DB message ID map for this thread
    const cliMap = this.state.cliToDbMsgId.get(threadId) ?? new Map<string, string>();
    this.state.cliToDbMsgId.set(threadId, cliMap);

    // Combine all text blocks into a single string
    const textContent = decodeUnicodeEscapes(
      msg.message.content
        .filter((b): b is { type: 'text'; text: string } => 'text' in b && !!b.text)
        .map((b) => b.text)
        .join('\n\n'),
    );

    // Count tool_use blocks in this message
    const toolUseBlocks = msg.message.content.filter(
      (b: any) => 'type' in b && b.type === 'tool_use',
    );
    log.info('assistant message', {
      ...(await this.threadCtx(threadId)),
      cliMsgId,
      hasText: String(!!textContent),
      textChars: String(textContent.length),
      textContent: textContent || '',
      toolUseCount: String(toolUseBlocks.length),
      toolNames: toolUseBlocks.map((b: any) => b.name).join(','),
    });

    if (textContent) {
      let msgId = this.state.currentAssistantMsgId.get(threadId) || cliMap.get(cliMsgId);
      if (msgId) {
        await this.threadManager.updateMessage(msgId, textContent);
      } else {
        msgId = await this.threadManager.insertMessage({
          threadId,
          role: 'assistant',
          content: textContent,
        });
      }
      this.state.currentAssistantMsgId.set(threadId, msgId);
      cliMap.set(cliMsgId, msgId);

      await this.emitWS(threadId, 'agent:message', {
        messageId: msgId,
        role: 'assistant',
        content: textContent,
      });
    }

    // Emit per-message context usage if available.
    // usage.input_tokens from the Anthropic API represents the TOTAL input
    // tokens for this API call (system prompt + full conversation history),
    // so it directly reflects how full the context window is — no accumulation needed.
    const usage = msg.message.usage;
    if (usage) {
      this.state.cumulativeInputTokens.set(threadId, usage.input_tokens);
      await this.emitWS(threadId, 'agent:context_usage', {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cumulativeInputTokens: usage.input_tokens,
      });
    } else {
      log.debug('No usage data in assistant message', { namespace: 'agent', threadId });
    }

    // Handle tool calls (deduplicate — streaming sends cumulative content)
    const seen = this.state.processedToolUseIds.get(threadId) ?? new Map<string, string>();
    for (const block of msg.message.content) {
      if ('type' in block && block.type === 'tool_use') {
        if (seen.has(block.id)) {
          log.debug('Skipping already-seen tool_use block (dedup)', {
            namespace: 'agent',
            threadId,
            tool: block.name,
            cliBlockId: block.id,
          });
          this.state.currentAssistantMsgId.delete(threadId);
          continue;
        }

        // Skip duplicate ExitPlanMode calls
        if (block.name === 'ExitPlanMode' && this.state.pendingUserInput.get(threadId) === 'plan') {
          log.debug('Skipping duplicate ExitPlanMode', { namespace: 'agent', threadId });
          seen.set(block.id, 'skipped');
          continue;
        }

        log.info(`tool_use: ${block.name}`, {
          ...(await this.threadCtx(threadId)),
          tool: block.name,
        });
        log.debug('tool_use input', {
          namespace: 'agent',
          threadId,
          tool: block.name,
          input: JSON.stringify(block.input),
        });

        // Ensure there's always a parent assistant message for tool calls
        let parentMsgId = this.state.currentAssistantMsgId.get(threadId) || cliMap.get(cliMsgId);
        if (!parentMsgId) {
          parentMsgId = await this.threadManager.insertMessage({
            threadId,
            role: 'assistant',
            content: '',
          });
          await this.emitWS(threadId, 'agent:message', {
            messageId: parentMsgId,
            role: 'assistant',
            content: '',
          });
        }
        this.state.currentAssistantMsgId.set(threadId, parentMsgId);
        cliMap.set(cliMsgId, parentMsgId);

        // Check DB for existing duplicate (guards against session resume re-sending old tool_use blocks)
        const inputJson = JSON.stringify(block.input);
        const existingTC = await this.threadManager.findToolCall(
          parentMsgId,
          block.name,
          inputJson,
        );

        if (existingTC) {
          log.debug('Dedup: found existing ToolCall in DB (resume re-send)', {
            namespace: 'agent',
            threadId,
            tool: block.name,
            existingId: existingTC.id,
          });
          seen.set(block.id, existingTC.id);
        } else {
          const toolCallId = await this.threadManager.insertToolCall({
            messageId: parentMsgId,
            name: block.name,
            input: inputJson,
          });
          seen.set(block.id, toolCallId);

          await this.emitWS(threadId, 'agent:tool_call', {
            toolCallId,
            messageId: parentMsgId,
            name: block.name,
            input: block.input,
          });
        }

        // Track if this tool call means Claude is waiting for user input
        if (block.name === 'AskUserQuestion') {
          log.info('AskUserQuestion detected — transitioning to waiting', {
            ...(await this.threadCtx(threadId)),
            previousPendingInput: this.state.pendingUserInput.get(threadId) ?? 'none',
            inputPreview: JSON.stringify(block.input).slice(0, 300),
          });
          this.state.pendingUserInput.set(threadId, 'question');
          const currentStatus = (await this.threadManager.getThread(threadId))?.status ?? 'running';
          const { status } = transitionStatus(
            threadId,
            { type: 'WAIT' },
            currentStatus as ThreadStatus,
          );
          log.debug('AskUserQuestion status transition', {
            namespace: 'agent',
            threadId,
            from: currentStatus,
            to: status,
          });
          await this.threadManager.updateThread(threadId, { status });
          await this.emitWS(threadId, 'agent:status', { status, waitingReason: 'question' });
        } else if (block.name === 'ExitPlanMode') {
          log.info('ExitPlanMode detected — transitioning to waiting', {
            ...(await this.threadCtx(threadId)),
            previousPendingInput: this.state.pendingUserInput.get(threadId) ?? 'none',
          });
          this.state.pendingUserInput.set(threadId, 'plan');
          const currentStatus = (await this.threadManager.getThread(threadId))?.status ?? 'running';
          const { status } = transitionStatus(
            threadId,
            { type: 'WAIT' },
            currentStatus as ThreadStatus,
          );
          log.debug('ExitPlanMode status transition', {
            namespace: 'agent',
            threadId,
            from: currentStatus,
            to: status,
          });
          await this.threadManager.updateThread(threadId, { status });
          await this.emitWS(threadId, 'agent:status', { status, waitingReason: 'plan' });
        } else {
          if (this.state.pendingUserInput.has(threadId)) {
            log.warn(
              'BUG-HUNT: Clearing pendingUserInput due to non-interactive tool call — may cause plan/question auto-continue',
              {
                ...(await this.threadCtx(threadId)),
                tool: block.name,
                wasPending: this.state.pendingUserInput.get(threadId),
              },
            );
          }
          this.state.pendingUserInput.delete(threadId);
        }

        // Reset currentAssistantMsgId — next CLI message's text should be a new DB message
        this.state.currentAssistantMsgId.delete(threadId);
      }
    }
    this.state.processedToolUseIds.set(threadId, seen);
  }

  // ── Tool result handling ───────────────────────────────────────

  private async handleToolResults(
    threadId: string,
    msg: CLIMessage & { type: 'user' },
  ): Promise<void> {
    const seen = this.state.processedToolUseIds.get(threadId);
    if (!seen || !msg.message.content) return;

    const resultBlocks = msg.message.content.filter((b: any) => b.type === 'tool_result');
    log.info('user message (tool_results)', {
      ...(await this.threadCtx(threadId)),
      resultCount: String(resultBlocks.length),
      toolUseIds: resultBlocks.map((b: any) => b.tool_use_id).join(','),
    });

    for (const block of msg.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const toolCallId = seen.get(block.tool_use_id);
        if (toolCallId && block.content) {
          const decodedOutput = decodeUnicodeEscapes(block.content);

          log.info(`tool_result: ${toolCallId}`, {
            ...(await this.threadCtx(threadId)),
            toolCallId,
            chars: String(decodedOutput.length),
          });
          log.debug('tool_result output', {
            namespace: 'agent',
            threadId,
            toolCallId,
            output: decodedOutput.slice(0, 500),
          });

          // Look up the tool call once for all checks below
          const tc = await this.threadManager.getToolCall(toolCallId);

          // For interactive tools (ExitPlanMode / AskUserQuestion): when the thread
          // is still "waiting" and pendingUserInput is set, the tool_result is an
          // auto-denial from the preToolUseHook (e.g. "Exit plan mode?"). Skip storing
          // it so the tool call remains "unanswered" and the UI keeps showing buttons.
          const isInteractive = tc?.name === 'AskUserQuestion' || tc?.name === 'ExitPlanMode';
          const isAutoDenial = isInteractive && this.state.pendingUserInput.has(threadId);

          if (isAutoDenial) {
            log.info(`Skipping auto-denial tool_result for ${tc!.name}`, {
              ...(await this.threadCtx(threadId)),
              toolCallId,
              autoDenialOutput: decodedOutput.slice(0, 100),
            });
          } else {
            await this.threadManager.updateToolCallOutput(toolCallId, decodedOutput);
            await this.emitWS(threadId, 'agent:tool_output', {
              toolCallId,
              output: decodedOutput,
            });
          }

          // Clear pending user input when AskUserQuestion/ExitPlanMode tool result is received
          // AND it's NOT an auto-denial (the SDK processed the user's actual answer)
          if (isInteractive && !isAutoDenial) {
            log.info(`${tc!.name} tool_result received — clearing pendingUserInput`, {
              ...(await this.threadCtx(threadId)),
              toolCallId: toolCallId ?? '',
              wasPending: this.state.pendingUserInput.get(threadId) ?? 'none',
            });
            this.state.pendingUserInput.delete(threadId);
          }

          // Detect permission denial pattern
          const permissionDeniedMatch = decodedOutput.match(
            /(?:requested permissions? to use|hasn't been granted|hasn't granted|permission.*denied|not in the allowed tools list)/i,
          );

          if (permissionDeniedMatch && tc?.name) {
            log.warn('Permission denied detected', { namespace: 'agent', threadId, tool: tc.name });
            this.state.pendingPermissionRequest.set(threadId, {
              toolName: tc.name,
              toolUseId: block.tool_use_id,
            });
          } else if (this.state.pendingPermissionRequest.has(threadId)) {
            // A tool succeeded without permission denial — the agent moved on,
            // so clear the stale permission request to avoid a false WAIT at result time.
            log.debug('Clearing stale pendingPermissionRequest after successful tool result', {
              ...(await this.threadCtx(threadId)),
              tool: tc?.name ?? 'unknown',
              wasPermission: this.state.pendingPermissionRequest.get(threadId)?.toolName ?? '',
            });
            this.state.pendingPermissionRequest.delete(threadId);
          }

          // Emit git:changed event for file-modifying tools
          const FILE_MODIFYING_TOOLS = new Set(['Write', 'Edit', 'Bash', 'NotebookEdit']);
          if (tc?.name && FILE_MODIFYING_TOOLS.has(tc.name) && !permissionDeniedMatch) {
            const thread = await this.threadManager.getThread(threadId);
            if (thread) {
              const project = await this.getProject(thread.projectId);
              threadEventBus.emit('git:changed', {
                threadId,
                projectId: thread.projectId,
                userId: thread.userId,
                worktreePath: thread.worktreePath ?? null,
                cwd: thread.worktreePath ?? project?.path ?? '',
                toolName: tc.name,
              });
            }
          }
        }
      }
    }
  }

  // ── Result handling ────────────────────────────────────────────

  private async handleResult(
    threadId: string,
    msg: CLIMessage & { type: 'result' },
  ): Promise<void> {
    if (this.state.resultReceived.has(threadId)) {
      log.debug('Ignoring duplicate result', { namespace: 'agent', threadId });
      return;
    }

    log.info('Agent completed', {
      ...(await this.threadCtx(threadId)),
      status: msg.subtype,
      cost: String(msg.total_cost_usd ?? 0),
      durationMs: String(msg.duration_ms ?? 0),
      numTurns: String(msg.num_turns ?? 0),
      isError: String(msg.is_error ?? false),
    });
    this.state.resultReceived.add(threadId);
    this.state.currentAssistantMsgId.delete(threadId);

    let waitingReason = this.state.pendingUserInput.get(threadId);
    const permReq = this.state.pendingPermissionRequest.get(threadId);

    log.debug('handleResult state snapshot', {
      ...(await this.threadCtx(threadId)),
      pendingUserInput: waitingReason ?? 'none',
      pendingPermission: permReq ? permReq.toolName : 'none',
    });

    if (!waitingReason && permReq) {
      waitingReason = 'permission';
    }

    const isWaitingForUser = !!waitingReason;
    const currentStatus = (await this.threadManager.getThread(threadId))?.status ?? 'running';

    // Determine the machine event based on the result
    const resultEvent = isWaitingForUser
      ? { type: 'WAIT' as const, cost: msg.total_cost_usd, duration: msg.duration_ms }
      : msg.subtype === 'success'
        ? { type: 'COMPLETE' as const, cost: msg.total_cost_usd, duration: msg.duration_ms }
        : { type: 'FAIL' as const, cost: msg.total_cost_usd, duration: msg.duration_ms };

    const { status: finalStatus } = transitionStatus(
      threadId,
      resultEvent,
      currentStatus as ThreadStatus,
      msg.total_cost_usd ?? 0,
    );

    log.info('handleResult final transition', {
      ...(await this.threadCtx(threadId)),
      eventType: resultEvent.type,
      from: currentStatus,
      to: finalStatus,
      isWaitingForUser: String(isWaitingForUser),
      waitingReason: waitingReason ?? 'none',
    });

    this.state.pendingUserInput.delete(threadId);

    await this.threadManager.updateThread(threadId, {
      status: finalStatus,
      cost: msg.total_cost_usd,
      ...(finalStatus !== 'waiting' ? { completedAt: new Date().toISOString() } : {}),
    });

    // Auto-transition stage to 'review' when agent completes/fails
    if (finalStatus !== 'waiting') {
      const threadForStage = await this.threadManager.getThread(threadId);
      if (threadForStage && threadForStage.stage === 'in_progress') {
        await this.threadManager.updateThread(threadId, { stage: 'review' });
        const project = await this.getProject(threadForStage.projectId);
        threadEventBus.emit('thread:stage-changed', {
          threadId,
          projectId: threadForStage.projectId,
          userId: threadForStage.userId,
          worktreePath: threadForStage.worktreePath ?? null,
          cwd: threadForStage.worktreePath ?? project?.path ?? '',
          fromStage: 'in_progress',
          toStage: 'review',
        });
      }

      // Emit agent:completed
      const t = await this.threadManager.getThread(threadId);
      if (t) {
        const proj = await this.getProject(t.projectId);
        threadEventBus.emit('agent:completed', {
          threadId,
          projectId: t.projectId,
          userId: t.userId,
          worktreePath: t.worktreePath ?? null,
          cwd: t.worktreePath ?? proj?.path ?? '',
          status: finalStatus as 'completed' | 'failed' | 'stopped',
          cost: msg.total_cost_usd ?? 0,
        });
      }
    }

    const threadWithStage = await this.threadManager.getThread(threadId);

    // Build the error text from the result or errors array
    const errorText =
      finalStatus === 'failed'
        ? msg.result
          ? decodeUnicodeEscapes(msg.result)
          : (msg.errors?.[0] ?? undefined)
        : undefined;

    await this.emitWS(threadId, 'agent:result', {
      result: msg.result ? decodeUnicodeEscapes(msg.result) : msg.result,
      cost: msg.total_cost_usd,
      duration: msg.duration_ms,
      status: finalStatus,
      stage: threadWithStage?.stage,
      ...(finalStatus === 'failed' ? { errorReason: msg.subtype, error: errorText } : {}),
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
    const thread = await this.threadManager.getThread(threadId);
    if (!thread?.worktreePath || thread.mode !== 'worktree') return;

    const project = await this.getProject(thread.projectId);
    if (!project) return;

    const summaryResult = await getStatusSummary(
      thread.worktreePath,
      thread.baseBranch ?? undefined,
      project.path,
    );
    if (summaryResult.isErr()) return;
    const summary = summaryResult.value;

    const branchKey = thread.branch
      ? `${thread.projectId}:${thread.branch}`
      : thread.baseBranch
        ? `tid:${threadId}`
        : thread.projectId;

    await this.emitWS(threadId, 'git:status', {
      statuses: [
        {
          threadId,
          branchKey,
          state: deriveGitSyncState(summary),
          ...summary,
        },
      ],
    });
  }
}
