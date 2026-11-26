/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain emits: agent:message, agent:tool_call, agent:tool_output, agent:result, agent:status, git:changed, thread:stage-changed
 * @domain depends: AgentStateTracker, ThreadManager, WSBroker, ThreadEventBus
 */

import type { CLIMessage } from '@funny/core/agents';
import type {
  AgentProvider,
  ThreadStatus,
  WaitingReason,
  WSContextUsageData,
  WSEvent,
} from '@funny/shared';
import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { isObject } from '../lib/value-guards.js';
import type { WSEventData } from './agent-event-router.js';
import {
  emitGitStatus as emitThreadGitStatus,
  LATEST_TURN_WINDOW,
  loadLatestTurn,
  persistChangedFilesSummary as persistSessionChanges,
} from './agent-message-handler/changed-files-summary.js';
import type { HandlerProject, MessageHandlerContext } from './agent-message-handler/context.js';
import {
  decodeUnicodeEscapes,
  knownStage,
  normalizeToolResultContent,
  resultErrorFields,
  resultEventType,
  serializeToolInput,
  type ToolInput,
} from './agent-message-handler/helpers.js';
import { handleToolUseBlocks } from './agent-message-handler/tool-use.js';
import { redactDeep } from './agent-startup/project-secrets.js';
import type { AgentStateTracker } from './agent-state.js';
import { flushPendingMessageUpdates } from './remote-thread-data-client.js';
import type { IThreadManager, IWSBroker } from './server-interfaces.js';
import { getServices } from './service-registry.js';
import { threadEventBus } from './thread-event-bus.js';
import { transitionStatus } from './thread-status-machine.js';

/** Token usage on an assistant message, under the field names each provider reports. */
interface AssistantMessageUsage {
  input_tokens?: number;
  inputTokens?: number;
  used?: number;
  max_tokens?: number;
  maxTokens?: number;
  size?: number;
  cache_read_input_tokens?: number;
  cachedReadTokens?: number;
  cacheReadTokens?: number;
  cache_creation_input_tokens?: number;
  cachedWriteTokens?: number;
  cacheWriteTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
}

/**
 * Handles all CLI messages from Claude processes — system init,
 * assistant text/tool_use, user tool_result, and result.
 */
export type ProjectLookup = (id: string) => HandlerProject | undefined;

/** Tag a context-usage event with the provider and model of the run that produced it. */
function setUsageRun(
  data: WSContextUsageData,
  run: { provider?: AgentProvider; model?: string },
): void {
  if (run.provider) data.provider = run.provider;
  if (run.model) data.model = run.model;
}

/** The message's `subtype`, for the debug log; only some CLI messages have one. */
function messageSubtype(msg: CLIMessage): string | undefined {
  return 'subtype' in msg ? msg.subtype : undefined;
}

export class AgentMessageHandler {
  private projectLookup: ProjectLookup | undefined;
  /** What the modules split out of this handler read and call. */
  private readonly ctx: MessageHandlerContext;

  constructor(
    private state: AgentStateTracker,
    private threadManager: IThreadManager,
    private wsBroker: IWSBroker,
    getProject?: ProjectLookup,
  ) {
    this.projectLookup = getProject;
    this.ctx = {
      state,
      threadManager,
      getProject: (id) => this.getProject(id),
      emitWS: (threadId, type, data) => this.emitWS(threadId, type, data),
      threadCtx: (threadId) => this.threadCtx(threadId),
    };
  }

  /** Lazy-load project lookup to avoid importing the singleton DB in tests */
  private async getProject(id: string): Promise<HandlerProject | undefined> {
    if (!this.projectLookup) {
      const { getServices } = require('./service-registry.js');
      this.projectLookup = getServices().projects.getProject;
    }
    return this.projectLookup!(id);
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

  private async emitWS<T extends WSEvent['type']>(
    threadId: string,
    type: T,
    data: WSEventData<T>,
  ): Promise<void> {
    // SAFETY: `data` is WSEventData<T>, the data of the WSEvent member whose `type` is T,
    // so the object is that member; TypeScript cannot correlate the generic pair itself.
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

  async handle(threadId: string, rawMsg: CLIMessage): Promise<void> {
    // Project secrets the agent was started with are replaced here, once, so
    // everything below (the stored transcript, the live stream, the debug
    // logs) sees the same redacted message (project-secrets).
    const msg = redactDeep(rawMsg, this.state.secretRedactors.get(threadId));
    // Every message is activity: without this the stale sweep (1h) evicted a
    // long-running agent's dedup maps mid-run, duplicating messages/tool calls.
    this.state.touch(threadId);
    log.debug('handle() raw message', {
      namespace: 'agent',
      threadId,
      type: msg.type,
      subtype: messageSubtype(msg),
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
        initSlashCommands: JSON.stringify(msg.slashCommands ?? []),
      });
      log.info('Session ID persisted to server', {
        namespace: 'agent',
        threadId,
        sessionId: msg.session_id,
      });

      // Capture the SDK-reported slash commands so the send boundary can reject
      // an unknown /command instead of forwarding it to the model as text.
      if (msg.slashCommands?.length) {
        this.state.supportedSlashCommands.set(
          threadId,
          new Set(msg.slashCommands.map((c) => c.replace(/^\//, ''))),
        );
      }

      await this.emitWS(threadId, 'agent:init', {
        tools: msg.tools ?? [],
        cwd: msg.cwd ?? '',
        model: msg.model ?? '',
        slashCommands: msg.slashCommands ?? [],
      });
      return;
    }

    // Mid-session refresh of available slash commands (e.g. skills discovered
    // dynamically). Replace the cached set so the send-boundary guard stays
    // accurate.
    if (msg.type === 'commands_changed') {
      const commands = msg.commands.map((c) => c.replace(/^\//, ''));
      this.state.supportedSlashCommands.set(threadId, new Set(commands));
      // Persist + mirror to the client so the slash autocomplete reflects
      // commands discovered mid-session (e.g. dynamically loaded skills).
      await this.threadManager.updateThread(threadId, {
        initSlashCommands: JSON.stringify(commands),
      });
      const thread = await this.threadManager.getThread(threadId);
      await this.emitWS(threadId, 'agent:init', {
        // SAFETY: initTools is only written as JSON.stringify of an init message's
        // `tools` (a string[]): above, and in ingest-mapper for external sessions.
        tools: thread?.initTools ? (JSON.parse(thread.initTools) as string[]) : [],
        cwd: thread?.initCwd ?? '',
        model: thread?.model ?? '',
        slashCommands: commands,
      });
      return;
    }

    if (msg.type === 'permission_request') {
      await this.handleStructuredPermissionRequest(threadId, msg);
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
      // After compaction the context is the summary, not empty — track the
      // SDK-reported post-compaction size (0 when unavailable) so the ring
      // shows the real reduced usage instead of freezing or vanishing.
      this.state.cumulativeInputTokens.set(threadId, msg.postTokens);
      await this.emitWS(threadId, 'agent:compact_boundary', {
        trigger: msg.trigger,
        preTokens: msg.preTokens,
        postTokens: msg.postTokens,
        timestamp,
      });

      // Persist to thread_events so it survives page refreshes
      getServices()
        .threadEvents.saveThreadEvent(threadId, 'compact_boundary', {
          trigger: msg.trigger,
          preTokens: msg.preTokens,
          postTokens: msg.postTokens,
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

    if (msg.type === 'context_breakdown') {
      await this.handleContextBreakdown(threadId, msg);
      return;
    }

    if (msg.type === 'rate_limit') {
      await this.handleRateLimit(threadId, msg);
      return;
    }

    if (msg.type === 'account') {
      const runProfile = await this.runAgentProfile(threadId);
      await this.emitWS(threadId, 'agent:account', {
        provider: msg.provider ?? runProfile.provider,
        profileId: runProfile.profileId,
        profileName: runProfile.profileName,
        account: msg.info,
        usage: msg.usage,
      });
      return;
    }

    // Result — agent finished
    if (msg.type === 'result') {
      await this.handleResult(threadId, msg);
    }
  }

  /**
   * End-of-turn context breakdown (Claude SDK) — rides on the existing
   * context-usage event so the client's ring keeps a single source.
   */
  private async handleContextBreakdown(
    threadId: string,
    msg: Extract<CLIMessage, { type: 'context_breakdown' }>,
  ): Promise<void> {
    const cumulative = this.state.cumulativeInputTokens.get(threadId) ?? msg.breakdown.totalTokens;
    const data: WSContextUsageData = {
      inputTokens: cumulative,
      outputTokens: 0,
      cumulativeInputTokens: cumulative,
      breakdown: msg.breakdown,
    };
    setUsageRun(data, await this.runAgentProfile(threadId));
    await this.emitWS(threadId, 'agent:context_usage', data);
  }

  /** Rate limit — claude.ai subscription quota update. */
  private async handleRateLimit(
    threadId: string,
    msg: Extract<CLIMessage, { type: 'rate_limit' }>,
  ): Promise<void> {
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
  }

  /**
   * The execution profile the thread's current run uses, so the client can
   * key the account's usage by profile rather than by thread. Read from the thread
   * row (written before the agent starts) once per run.
   */
  private async runAgentProfile(threadId: string): Promise<{
    provider?: AgentProvider;
    model?: string;
    profileId: string | null;
    profileName: string | null;
  }> {
    const cached = this.state.runAgentProfiles.get(threadId);
    if (cached) return cached;
    let thread;
    try {
      thread = await this.threadManager.getThread(threadId);
    } catch (err) {
      log.warn('Failed to read the thread agent profile', {
        namespace: 'agent',
        threadId,
        error: err,
      });
      return { profileId: null, profileName: null };
    }
    const ref = {
      provider: thread?.provider,
      model: thread?.model,
      profileId: thread?.agentProfileId ?? null,
      profileName: thread?.agentProfileName ?? null,
    };
    this.state.runAgentProfiles.set(threadId, ref);
    return ref;
  }

  // ── Assistant message handling ─────────────────────────────────

  private async handleStructuredPermissionRequest(
    threadId: string,
    msg: Extract<CLIMessage, { type: 'permission_request' }>,
  ): Promise<void> {
    const thread = await this.threadManager.getThread(threadId);
    const requestedAt = new Date().toISOString();
    const pendingPermissionRequest = {
      requestId: msg.requestId,
      threadId,
      // ACP has initialized the session before it can request a tool. The
      // request id remains a safe unique fallback for unusual init failures.
      runId: thread?.sessionId ?? msg.requestId,
      transport: msg.transport,
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      toolInput: msg.toolInput || undefined,
      canAlwaysAllow: msg.canAlwaysAllow,
      canDeny: msg.canDeny,
      requestedAt,
    } as const;

    await this.threadManager.createPendingPermissionRequest?.(pendingPermissionRequest);
    this.state.structuredPermissionRequests.set(threadId, pendingPermissionRequest);
    // SAFETY: threads.status is only written from thread state machine results (or the
    // 'running' default here), so the stored string is a ThreadStatus.
    const currentStatus = (thread?.status ?? 'running') as ThreadStatus;
    const { status } = transitionStatus(threadId, { type: 'WAIT' }, currentStatus);
    await this.threadManager.updateThread(threadId, { status });
    await this.emitWS(threadId, 'agent:status', {
      status,
      waitingReason: 'permission',
      pendingPermissionRequest,
      permissionApprovalCapability: { kind: 'structured', transport: msg.transport },
    });
  }

  private async reopenContinuedTurn(
    threadId: string,
    cliMsgId: string,
    cliMap: Map<string, string>,
  ): Promise<void> {
    // A live provider session can continue after a turn result (for example
    // during resume). New assistant output must reopen the run; otherwise
    // the UI stays completed and result deduplication drops its actual end.
    // Late updates to an already-known message are not a new turn. Preserve
    // explicit stops and permission waits as well.
    if (this.state.resultReceived.has(threadId) && !cliMap.has(cliMsgId)) {
      const thread = await this.threadManager.getThread(threadId);
      if (thread?.status === 'completed' || thread?.status === 'failed') {
        const { status } = transitionStatus(threadId, { type: 'START' }, thread.status);
        await this.threadManager.updateThread(threadId, { status, completedAt: null });
        this.state.resultReceived.delete(threadId);
        this.state.completedEmitted.delete(threadId);
        await this.emitWS(threadId, 'agent:status', { status });
      }
    }
  }

  private async handleAssistantMessage(
    threadId: string,
    msg: CLIMessage & { type: 'assistant' },
  ): Promise<void> {
    const cliMsgId = msg.message.id;

    // Get or init the CLI→DB message ID map for this thread
    const cliMap = this.state.cliToDbMsgId.get(threadId) ?? new Map<string, string>();
    this.state.cliToDbMsgId.set(threadId, cliMap);

    await this.reopenContinuedTurn(threadId, cliMsgId, cliMap);

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

    // Real assistant text means the agent made progress AFTER any earlier
    // provider error — so it recovered. Clear the pending-provider-error flag
    // so the run isn't forced into `failed` at result time.
    if (textContent) {
      this.state.providerErrorPending.delete(threadId);
    }

    if (textContent) {
      // Some providers publish a stable item ID for every incremental update.
      // An unseen stable ID starts a distinct message; otherwise it could be
      // merged into the current card and later appear to jump around the
      // thread. Keep the current-message fallback for legacy providers whose
      // IDs change between chunks.
      let msgId = cliMap.get(cliMsgId);
      if (!msgId && !msg.hasStableMessageId) {
        msgId = this.state.currentAssistantMsgId.get(threadId);
      }
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
        this.state.markOwnMessage(threadId, msgId);
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
    // The compaction-summary assistant message carries a `compaction` content
    // block and reports `usage` equal to the FULL pre-compaction context it
    // just read to build the summary. The SDK emits it AFTER the
    // `compact_boundary` system message, so forwarding its usage as an
    // `agent:context_usage` event would clobber the reset the client just
    // applied on the boundary — leaving the context-usage ring frozen at the
    // pre-compaction value (the "compacted but the meter didn't move" bug).
    // The boundary is authoritative for post-compaction usage, so skip this.
    const isCompactionSummary = msg.message.content.some(
      (b: any) => isObject(b) && 'type' in b && b.type === 'compaction',
    );
    const usage: AssistantMessageUsage | undefined = isCompactionSummary
      ? undefined
      : msg.message.usage;
    if (usage) {
      const inputTokens = usage.input_tokens ?? usage.inputTokens ?? usage.used ?? 0;
      const cacheRead =
        usage.cache_read_input_tokens ?? usage.cachedReadTokens ?? usage.cacheReadTokens ?? 0;
      const cacheCreation =
        usage.cache_creation_input_tokens ?? usage.cachedWriteTokens ?? usage.cacheWriteTokens ?? 0;
      const outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0;
      const reportedMax = usage.max_tokens ?? usage.maxTokens ?? usage.size;
      const maxTokens =
        reportedMax !== undefined && Number.isFinite(reportedMax) && reportedMax > 0
          ? reportedMax
          : undefined;
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
      // Cached per run: one thread read at the first usage event.
      const data: WSContextUsageData = {
        inputTokens: totalInputTokens,
        outputTokens,
        cumulativeInputTokens: totalInputTokens,
      };
      setUsageRun(data, await this.runAgentProfile(threadId));
      if (maxTokens) data.maxTokens = maxTokens;
      void this.emitWS(threadId, 'agent:context_usage', data);
    } else {
      log.debug('No usage data in assistant message', { namespace: 'agent', threadId });
    }

    await handleToolUseBlocks(this.ctx, threadId, msg, cliMap);
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

          // The name recorded at insert covers the common case without a
          // server round trip. Interactive tools still read the row (they need
          // to know whether the user already answered), as does an unknown
          // tool call (e.g. state lost across a runner restart).
          const knownName = this.state.toolCallName(threadId, toolCallId);
          const needsRow =
            !knownName || knownName === 'AskUserQuestion' || knownName === 'ExitPlanMode';
          const tc: { name?: string; input?: string | null; output?: string | null } | undefined =
            needsRow ? await this.threadManager.getToolCall(toolCallId) : { name: knownName };

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

          // Detect permission denial pattern (includes SDK native messages and hook denial messages).
          // Plain command failures like ssh(1) "Permission denied" are not approval prompts.
          const permissionDeniedMatch = decodedOutput.match(
            /(?:requested permissions? to (?:use|edit)|is a sensitive file|hasn't been granted|hasn't granted|not in the allowed tools list|hook error:.*(?:approval|permission)|denied this tool|Blocked by hook)/i,
          );

          if (permissionDeniedMatch && tc?.name) {
            log.warn('Permission denied detected', { namespace: 'agent', threadId, tool: tc.name });
            // Rare path: the input is only kept in the DB.
            const input =
              tc.input ??
              (needsRow ? null : (await this.threadManager.getToolCall(toolCallId))?.input);
            const parsed = input ? parseStoredJson(z.unknown(), input, 'tool input') : null;
            const parsedInput: ToolInput = parsed?.ok ? parsed.value : undefined;
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

  /**
   * The unrecovered provider error that ends this run as `failed`, if any.
   * A real user-input/permission wait wins over it.
   */
  private resolveProviderError(
    threadId: string,
    waitingReason: WaitingReason | undefined,
    resultSubtype: string,
  ): string | undefined {
    if (waitingReason) return undefined;
    const providerError = this.state.providerErrorPending.get(threadId);
    if (providerError !== undefined) {
      log.info('handleResult forcing provider-error failure', {
        namespace: 'agent-message',
        threadId,
        resultSubtype,
      });
    }
    return providerError;
  }

  private async handleResult(
    threadId: string,
    msg: CLIMessage & { type: 'result' },
  ): Promise<void> {
    if (this.state.resultReceived.has(threadId)) {
      log.debug('Ignoring duplicate result', { namespace: 'agent', threadId });
      return;
    }

    // Flush debounced update_message buffers so the DB has the final
    // assistant text BEFORE the run is marked complete. Otherwise a fast
    // reload right after completion can race the 100ms debounce window.
    flushPendingMessageUpdates();

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

    // An unrecovered provider error (rate limit / API error) ends the run as
    // `failed`, even when the SDK reports `success`: the process has exited,
    // so there is nothing waiting for input. A real user-input/permission wait
    // still wins.
    const isWaitingForUser = !!waitingReason;
    const providerError = this.resolveProviderError(threadId, waitingReason, msg.subtype);

    const preThread = await this.threadManager.getThread(threadId);
    const currentStatus = preThread?.status ?? 'running';

    // Determine the machine event based on the result
    const resultEvent = {
      type: resultEventType(isWaitingForUser, msg.subtype, providerError),
      cost: msg.total_cost_usd,
      duration: msg.duration_ms,
    };

    const { status: finalStatus } = transitionStatus(
      threadId,
      resultEvent,
      // SAFETY: threads.status is only written from thread state machine results (or the
      // 'running' default above), so the stored string is a ThreadStatus.
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
    this.state.providerErrorPending.delete(threadId);

    await this.threadManager.updateThread(threadId, {
      status: finalStatus,
      cost: msg.total_cost_usd,
      completedAt: finalStatus !== 'waiting' ? new Date().toISOString() : undefined,
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

      // Emit agent:completed (reuse already-fetched thread).
      // Idempotency: shared `completedEmitted` set with AgentEventRouter —
      // if a failure/stop path already emitted for this run, skip here.
      const t = updatedThread ?? preThread;
      if (t && !this.state.completedEmitted.has(threadId)) {
        this.state.completedEmitted.add(threadId);
        const proj = await this.getProject(t.projectId);
        threadEventBus.emit('agent:completed', {
          threadId,
          projectId: t.projectId,
          userId: t.userId,
          worktreePath: t.worktreePath ?? null,
          cwd: t.worktreePath ?? proj?.path ?? '',
          // SAFETY: inside `finalStatus !== 'waiting'`, finalStatus is the COMPLETE / FAIL
          // transition's result: 'completed' or 'failed', or 'stopped' when a stopped
          // thread absorbs a late result.
          status: finalStatus as 'completed' | 'failed' | 'stopped',
          cost: msg.total_cost_usd ?? 0,
        });
      }
    }

    // Re-fetch thread only if we didn't already in the block above
    const threadWithStage =
      finalStatus !== 'waiting' ? await this.threadManager.getThread(threadId) : preThread;

    await this.emitWS(threadId, 'agent:result', {
      result: msg.result ? decodeUnicodeEscapes(msg.result) : msg.result,
      cost: msg.total_cost_usd,
      duration: msg.duration_ms,
      status: finalStatus,
      stage: knownStage(threadWithStage?.stage),
      ...(finalStatus === 'failed' ? resultErrorFields(msg, providerError) : null),
      waitingReason: waitingReason || undefined,
      permissionRequest: permReq
        ? { toolName: permReq.toolName, toolInput: permReq.toolInput }
        : undefined,
    });

    if (permReq) {
      this.state.pendingPermissionRequest.delete(threadId);
    }

    // Snapshot the session's changed-files summary once the run truly finishes
    // (not while merely waiting for user input). Persisted as a thread event so
    // it renders as a frozen "what this session changed" card — only at the end,
    // and without recomputing the diff on every refresh. Best-effort.
    if (finalStatus !== 'waiting') {
      await this.persistChangedFilesSummary(threadId).catch((err) => {
        log.warn('Failed to persist changed-files summary', {
          namespace: 'agent',
          threadId,
          // SAFETY: only `.message` is read, optional-chained; for a rejection that is not
          // Error-like it is undefined and `String(err)` is logged instead.
          error: (err as Error)?.message ?? String(err),
        });
      });
    }

    // Emit git status for worktree threads (async, non-blocking)
    this.emitGitStatus(threadId).catch(() => {});
  }

  // ── Changed-files session summary ──────────────────────────────

  static readonly LATEST_TURN_WINDOW = LATEST_TURN_WINDOW;

  /** The newest page of messages that holds the latest user turn (see `loadLatestTurn`). */
  private loadLatestTurn(threadId: string) {
    return loadLatestTurn(this.ctx, threadId);
  }

  /**
   * Snapshot the files modified during the just-completed session and persist
   * them as a `changed_files_summary` thread event (see
   * `agent-message-handler/changed-files-summary.ts`). Called once per run
   * from every terminal path (result, stop, failure).
   */
  async persistChangedFilesSummary(threadId: string): Promise<void> {
    await persistSessionChanges(this.ctx, threadId);
  }

  // ── Git status emission ────────────────────────────────────────

  async emitGitStatus(threadId: string): Promise<void> {
    await emitThreadGitStatus(this.ctx, threadId);
  }
}
