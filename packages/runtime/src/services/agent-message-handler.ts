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
import { computeBranchKey } from '../utils/git-status-helpers.js';
import type { AgentStateTracker } from './agent-state.js';
import type { IThreadManager, IWSBroker } from './server-interfaces.js';
import { getServices } from './service-registry.js';
import { threadEventBus } from './thread-event-bus.js';
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
 * Normalize a tool_result `content` field to a string. The Anthropic SDK may
 * deliver it as a plain string or as an array of content blocks
 * (`[{ type: 'text', text: '…' }, …]`). Image / non-text blocks are rendered
 * as a placeholder so callers always see a non-empty string when there is
 * any payload at all.
 */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          if (typeof b.text === 'string') return b.text;
          if (b.type === 'image') return '[image]';
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Serialize a tool's input to a short string for client display in the
 * permission approval card. Bash gets its raw command; other tools get
 * a truncated JSON representation.
 */
function serializeToolInput(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (toolName === 'Bash' && 'command' in input && typeof (input as any).command === 'string') {
    return (input as any).command as string;
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  } catch {
    return undefined;
  }
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

  /** Lazy-load project lookup to avoid importing the singleton DB in tests */
  private async getProject(id: string): Promise<{ path: string; [key: string]: any } | undefined> {
    if (!this._getProject) {
      const { getServices } = require('./service-registry.js');
      this._getProject = getServices().projects.getProject;
    }
    return this._getProject!(id);
  }

  /** Build common log attributes with thread context for observability.
   *  Resilient to WS failures — falls back to minimal context if the
   *  thread lookup fails (e.g. during a transient WS disconnect). */
  private async threadCtx(threadId: string): Promise<Record<string, string>> {
    try {
      const thread = await this.threadManager.getThread(threadId);
      return {
        namespace: 'agent',
        threadId,
        userId: thread?.userId ?? 'unknown',
        projectId: thread?.projectId ?? 'unknown',
        threadStatus: thread?.status ?? 'unknown',
        sessionId: thread?.sessionId ?? '',
      };
    } catch {
      return {
        namespace: 'agent',
        threadId,
        userId: 'unknown',
        projectId: 'unknown',
        threadStatus: 'unknown',
        sessionId: '',
      };
    }
  }

  /** Tools that require user approval in confirmEdit mode */
  private static readonly CONFIRM_EDIT_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);

  /** Check if the tool_use requires user approval (confirmEdit mode + file-editing tool) */
  private async isConfirmEditTool(threadId: string, toolName: string): Promise<boolean> {
    if (!AgentMessageHandler.CONFIRM_EDIT_TOOLS.has(toolName)) return false;
    const thread = await this.threadManager.getThread(threadId);
    return thread?.permissionMode === 'confirmEdit';
  }

  private async emitWS(threadId: string, type: WSEvent['type'], data: unknown): Promise<void> {
    const event = { type, threadId, data } as WSEvent;

    // Fast path: use cached userId to avoid a DB read on every emission
    let userId = this.state.threadUserIds.get(threadId);
    if (!userId) {
      try {
        const thread = await this.threadManager.getThread(threadId);
        userId = thread?.userId;
        if (userId) this.state.threadUserIds.set(threadId, userId);
      } catch {
        // WS may be temporarily disconnected — emit without user filter
      }
    }

    if (userId) {
      this.wsBroker.emitToUser(userId, event);
    } else {
      this.wsBroker.emit(event);
    }
  }

  async handle(threadId: string, msg: CLIMessage): Promise<void> {
    log.debug('handle() raw message', {
      namespace: 'agent',
      threadId,
      type: msg.type,
      subtype: (msg as any).subtype,
    });

    // System init — capture session ID and broadcast init info
    if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
      log.info('Session initialized — persisting sessionId', {
        ...(await this.threadCtx(threadId)),
        newSessionId: msg.session_id,
      });
      await this.threadManager.updateThread(threadId, {
        sessionId: msg.session_id,
        initTools: JSON.stringify(msg.tools ?? []),
        initCwd: msg.cwd ?? '',
      });
      log.info('Session ID persisted to server', {
        namespace: 'agent',
        threadId,
        sessionId: msg.session_id,
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
      getServices()
        .threadEvents.saveThreadEvent(threadId, 'compact_boundary', {
          trigger: msg.trigger,
          preTokens: msg.preTokens,
          timestamp,
        })
        .catch((err) => {
          log.error('Failed to persist compact_boundary event', {
            namespace: 'agent',
            threadId,
            error: err,
          });
        });
      return;
    }

    // Rate limit — claude.ai subscription quota update
    if (msg.type === 'rate_limit') {
      log.info('Rate limit info', {
        namespace: 'agent',
        threadId,
        status: msg.info.status,
        rateLimitType: msg.info.rateLimitType ?? '',
        utilization: msg.info.utilization ?? 0,
        resetsAt: msg.info.resetsAt ?? 0,
        isUsingOverage: msg.info.isUsingOverage ?? false,
      });
      await this.emitWS(threadId, 'agent:rate_limit', { info: msg.info });
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
      namespace: 'agent',
      threadId,
      cliMsgId,
      hasText: String(!!textContent),
      textChars: String(textContent.length),
      toolUseCount: String(toolUseBlocks.length),
      toolNames: toolUseBlocks.map((b: any) => b.name).join(','),
    });

    // Log the raw CLIMessage to Abbacchio for debugging — captures the
    // original content array with mixed text/tool_use blocks from the model.
    log.debug('raw assistant CLIMessage', {
      namespace: 'agent',
      threadId,
      cliMsgId,
      raw: JSON.stringify(msg.message),
    });

    if (textContent) {
      let msgId = this.state.currentAssistantMsgId.get(threadId) || cliMap.get(cliMsgId);
      if (msgId) {
        // Existing message: emit WS immediately, persist in background
        // This gives the user instant feedback while DB writes happen async
        void this.emitWS(threadId, 'agent:message', {
          messageId: msgId,
          role: 'assistant',
          content: textContent,
        });
        void this.threadManager.updateMessage(msgId, textContent);
      } else {
        // New message: must insert first to get the DB-generated msgId
        msgId = await this.threadManager.insertMessage({
          threadId,
          role: 'assistant',
          content: textContent,
        });
        await this.emitWS(threadId, 'agent:message', {
          messageId: msgId,
          role: 'assistant',
          content: textContent,
        });
      }
      this.state.currentAssistantMsgId.set(threadId, msgId);
      cliMap.set(cliMsgId, msgId);
    }

    // Emit per-message context usage if available.
    // With prompt caching, the Anthropic API splits input tokens across:
    //   input_tokens — uncached (new) tokens only (often very small, e.g. 1-4)
    //   cache_read_input_tokens — tokens served from cache (the bulk)
    //   cache_creation_input_tokens — tokens being cached for the first time
    // The total = input_tokens + cache_read + cache_creation represents the
    // **full context window size** for this API call, not an incremental addition.
    // So we use the latest totalInputTokens directly as the context window usage
    // rather than accumulating across messages (which would vastly overcount).
    const usage = msg.message.usage as Record<string, unknown> | undefined;
    if (usage) {
      const inputTokens = (usage.input_tokens as number) ?? 0;
      const cacheRead = (usage.cache_read_input_tokens as number) ?? 0;
      const cacheCreation = (usage.cache_creation_input_tokens as number) ?? 0;
      const outputTokens = (usage.output_tokens as number) ?? 0;
      const totalInputTokens = inputTokens + cacheRead + cacheCreation;

      log.info('Assistant message usage (DEBUG)', {
        namespace: 'agent',
        threadId,
        rawUsageKeys: Object.keys(usage).join(','),
        rawUsage: JSON.stringify(usage),
        inputTokens,
        cacheRead,
        cacheCreation,
        totalInputTokens,
        outputTokens,
      });

      // Each API response reports the full context window size (not a delta),
      // so just store the latest value instead of accumulating.
      this.state.cumulativeInputTokens.set(threadId, totalInputTokens);
      void this.emitWS(threadId, 'agent:context_usage', {
        inputTokens: totalInputTokens,
        outputTokens,
        cumulativeInputTokens: totalInputTokens,
      });
    } else {
      log.debug('No usage data in assistant message', { namespace: 'agent', threadId });
    }

    // Handle tool calls (deduplicate — streaming sends cumulative content)
    const seen = this.state.processedToolUseIds.get(threadId) ?? new Map<string, string>();

    // Resolve parent_tool_use_id → DB parentToolCallId for subagent tool calls
    const parentToolCallId = msg.parent_tool_use_id
      ? (seen.get(msg.parent_tool_use_id) ?? null)
      : null;

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

        // Skip duplicate interactive tool calls when already waiting for user input
        if (block.name === 'ExitPlanMode' && this.state.pendingUserInput.get(threadId) === 'plan') {
          log.debug('Skipping duplicate ExitPlanMode', { namespace: 'agent', threadId });
          seen.set(block.id, 'skipped');
          continue;
        }
        if (
          block.name === 'AskUserQuestion' &&
          this.state.pendingUserInput.get(threadId) === 'question'
        ) {
          log.debug('Skipping duplicate AskUserQuestion', { namespace: 'agent', threadId });
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
            parentToolCallId,
          });
          seen.set(block.id, toolCallId);

          await this.emitWS(threadId, 'agent:tool_call', {
            toolCallId,
            messageId: parentMsgId,
            name: block.name,
            input: block.input,
            parentToolCallId,
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
        } else if (await this.isConfirmEditTool(threadId, block.name)) {
          // In confirmEdit mode, the preToolUseHook pauses the SDK for
          // Edit/Write/Bash/NotebookEdit until the user approves. Transition
          // the thread to "waiting" immediately when we see the tool_use block
          // so the client can show the PermissionApprovalCard.
          const dbToolCallId = seen.get(block.id);
          log.info(`confirmEdit: ${block.name} detected — transitioning to waiting`, {
            ...(await this.threadCtx(threadId)),
            tool: block.name,
            toolCallId: dbToolCallId ?? 'unknown',
          });
          const serializedInput = serializeToolInput(block.name, block.input);
          this.state.pendingPermissionRequest.set(threadId, {
            toolName: block.name,
            toolUseId: block.id,
            toolInput: serializedInput,
          });
          const currentStatus = (await this.threadManager.getThread(threadId))?.status ?? 'running';
          const { status } = transitionStatus(
            threadId,
            { type: 'WAIT' },
            currentStatus as ThreadStatus,
          );
          await this.threadManager.updateThread(threadId, { status });
          await this.emitWS(threadId, 'agent:status', {
            status,
            waitingReason: 'permission',
            permissionRequest: { toolName: block.name, toolInput: serializedInput },
          });
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

    // Log raw tool_result CLIMessage to Abbacchio for debugging
    log.debug('raw tool_result CLIMessage', {
      namespace: 'agent',
      threadId,
      raw: JSON.stringify(msg.message),
    });

    log.info('user message (tool_results)', {
      ...(await this.threadCtx(threadId)),
      resultCount: String(resultBlocks.length),
      toolUseIds: resultBlocks.map((b: any) => b.tool_use_id).join(','),
    });

    for (const block of msg.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const toolCallId = seen.get(block.tool_use_id);
        const rawContent = normalizeToolResultContent(block.content);
        if (toolCallId && rawContent) {
          const decodedOutput = decodeUnicodeEscapes(rawContent);

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

          // For interactive tools (ExitPlanMode / AskUserQuestion): detect and
          // discard auto-denial results from the preToolUseHook or SDK timeout.
          //
          // Detection layers:
          // 1. pendingUserInput is set → thread is still waiting for user response
          // 2. Output matches SDK permission prompt text ("Answer questions?" / "Exit plan mode?")
          //    → this is the SDK timeout or hook denial, not a real user answer
          // 3. Tool call already has output in DB → user already answered, this is a stale result
          const isInteractive = tc?.name === 'AskUserQuestion' || tc?.name === 'ExitPlanMode';

          const SDK_PERMISSION_PROMPTS = new Set(['Answer questions?', 'Exit plan mode?']);
          const isPendingDenial = isInteractive && this.state.pendingUserInput.has(threadId);
          const isSdkTimeoutPoison =
            isInteractive && SDK_PERMISSION_PROMPTS.has(decodedOutput.trim());
          const hasExistingAnswer = isInteractive && !!tc?.output;
          const isAutoDenial = isPendingDenial || isSdkTimeoutPoison || hasExistingAnswer;

          if (isAutoDenial) {
            const denialReason = isPendingDenial
              ? 'pendingUserInput'
              : isSdkTimeoutPoison
                ? 'sdkTimeoutPoison'
                : 'existingAnswer';
            log.info(`Skipping auto-denial tool_result for ${tc!.name}`, {
              ...(await this.threadCtx(threadId)),
              toolCallId,
              denialReason,
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

          // Detect permission denial pattern (includes SDK native messages and hook denial messages)
          const permissionDeniedMatch = decodedOutput.match(
            /(?:requested permissions? to (?:use|edit)|is a sensitive file|hasn't been granted|hasn't granted|permission.*denied|not in the allowed tools list|hook error:.*(?:approval|permission)|denied this tool|Blocked by hook)/i,
          );

          if (permissionDeniedMatch && tc?.name) {
            log.warn('Permission denied detected', { namespace: 'agent', threadId, tool: tc.name });
            let parsedInput: unknown = undefined;
            try {
              parsedInput = tc.input ? JSON.parse(tc.input) : undefined;
            } catch {
              parsedInput = undefined;
            }
            this.state.pendingPermissionRequest.set(threadId, {
              toolName: tc.name,
              toolUseId: block.tool_use_id,
              toolInput: serializeToolInput(tc.name, parsedInput),
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
      resultSubtype: msg.subtype,
    });

    // If a permission request is pending, always surface it to the client —
    // even when the agent gracefully exits with subtype 'success' after a
    // sensitive-path denial. Otherwise the client never learns it should
    // render the approval card.
    if (!waitingReason && permReq) {
      waitingReason = 'permission';
      log.info('handleResult forcing permission waiting status', {
        namespace: 'agent-message',
        threadId,
        tool: permReq.toolName,
        resultSubtype: msg.subtype,
      });
    }

    const isWaitingForUser = !!waitingReason;
    const preThread = await this.threadManager.getThread(threadId);
    const currentStatus = preThread?.status ?? 'running';

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
      namespace: 'agent-message',
      threadId,
      projectId: preThread?.projectId,
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
      // Re-fetch once after update to get the current stage
      const updatedThread = await this.threadManager.getThread(threadId);
      if (updatedThread && updatedThread.stage === 'in_progress') {
        await this.threadManager.updateThread(threadId, { stage: 'review' });
        const project = await this.getProject(updatedThread.projectId);
        threadEventBus.emit('thread:stage-changed', {
          threadId,
          projectId: updatedThread.projectId,
          userId: updatedThread.userId,
          worktreePath: updatedThread.worktreePath ?? null,
          cwd: updatedThread.worktreePath ?? project?.path ?? '',
          fromStage: 'in_progress',
          toStage: 'review',
        });
      }

      // Emit agent:completed (reuse already-fetched thread)
      const t = updatedThread ?? preThread;
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

    // Re-fetch thread only if we didn't already in the block above
    const threadWithStage =
      finalStatus !== 'waiting' ? await this.threadManager.getThread(threadId) : preThread;

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
      ...(permReq
        ? { permissionRequest: { toolName: permReq.toolName, toolInput: permReq.toolInput } }
        : {}),
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

    const branchKey = computeBranchKey(thread);

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
