/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain emits: agent:tool_call, agent:status
 * @domain depends: AgentStateTracker, ThreadManager
 */

import type { CLIMessage } from '@funny/core/agents';
import type { ThreadStatus } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { isObject, isString } from '../../lib/value-guards.js';
import { recordBashCheck } from '../checks/bash-check-metric.js';
import { transitionStatus } from '../thread-status-machine.js';
import type { MessageHandlerContext } from './context.js';
import { serializeToolInput, type ToolUseBlock } from './helpers.js';

/** Tools that require user approval in confirmEdit mode */
const CONFIRM_EDIT_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);

/** The CLI→DB ids one assistant message's tool_use blocks are recorded against. */
interface ToolUseScope {
  threadId: string;
  cliMsgId: string;
  cliMap: Map<string, string>;
  seen: Map<string, string>;
  parentToolCallId: string | null;
}

/** Check if the tool_use requires user approval (confirmEdit mode + file-editing tool) */
async function isConfirmEditTool(
  ctx: MessageHandlerContext,
  threadId: string,
  toolName: string,
): Promise<boolean> {
  if (!CONFIRM_EDIT_TOOLS.has(toolName)) return false;
  const thread = await ctx.threadManager.getThread(threadId);
  return thread?.permissionMode === 'confirmEdit';
}

/** Remember the provider's error text until the agent recovers or the run ends. */
function recordProviderError(
  ctx: MessageHandlerContext,
  threadId: string,
  block: ToolUseBlock,
): void {
  const error = isObject(block.input) && 'error' in block.input ? block.input.error : undefined;
  ctx.state.providerErrorPending.set(threadId, isString(error) ? error : 'Provider error');
}

/**
 * Whether the block was already handled: seen before (streaming sends
 * cumulative content), or a repeat of the interactive tool the thread
 * already waits on.
 */
function skipToolUse(ctx: MessageHandlerContext, scope: ToolUseScope, block: ToolUseBlock) {
  const { threadId, seen } = scope;
  if (seen.has(block.id)) {
    log.debug('Skipping already-seen tool_use block (dedup)', {
      namespace: 'agent',
      threadId,
      tool: block.name,
      cliBlockId: block.id,
    });
    ctx.state.currentAssistantMsgId.delete(threadId);
    return true;
  }

  // Skip duplicate interactive tool calls when already waiting for user input
  if (block.name === 'ExitPlanMode' && ctx.state.pendingUserInput.get(threadId) === 'plan') {
    log.debug('Skipping duplicate ExitPlanMode', { namespace: 'agent', threadId });
    seen.set(block.id, 'skipped');
    return true;
  }
  if (block.name === 'AskUserQuestion' && ctx.state.pendingUserInput.get(threadId) === 'question') {
    log.debug('Skipping duplicate AskUserQuestion', { namespace: 'agent', threadId });
    seen.set(block.id, 'skipped');
    return true;
  }
  return false;
}

/**
 * Ensure there's always a parent assistant message for tool calls.
 * The DB row is required as FK target for tool_calls.messageId, but
 * we deliberately do NOT emit `agent:message` for this empty
 * placeholder — the client would just store an empty assistant
 * bubble that render-items.ts filters out anyway, and across many
 * CLI messages this used to produce dozens of empty rows in the
 * client store (and matching log spam). `handleWSToolCall` creates
 * a synthetic parent message on demand when the first tool_call
 * referencing this messageId arrives, so the client stays correct.
 */
async function ensureParentMessage(
  ctx: MessageHandlerContext,
  scope: ToolUseScope,
): Promise<string> {
  const { threadId, cliMsgId, cliMap } = scope;
  let parentMsgId = ctx.state.currentAssistantMsgId.get(threadId) || cliMap.get(cliMsgId);
  if (!parentMsgId) {
    parentMsgId = await ctx.threadManager.insertMessage({
      threadId,
      role: 'assistant',
      content: '',
    });
    ctx.state.markOwnMessage(threadId, parentMsgId);
  }
  ctx.state.currentAssistantMsgId.set(threadId, parentMsgId);
  cliMap.set(cliMsgId, parentMsgId);
  return parentMsgId;
}

/** Record the tool call (or adopt the DB's copy of a resume re-send) and announce a new one. */
async function persistToolCall(
  ctx: MessageHandlerContext,
  scope: ToolUseScope,
  block: ToolUseBlock,
  parentMsgId: string,
): Promise<void> {
  const { threadId, seen, parentToolCallId } = scope;
  // Check DB for existing duplicate (guards against session resume
  // re-sending old tool_use blocks). Skipped for messages this process
  // created: their tool calls are all in `seen`, so a re-send was
  // already caught above and the lookup would cost a server round trip
  // (shipping the full input) for nothing.
  const inputJson = JSON.stringify(block.input);
  const existingTC = ctx.state.isOwnMessage(threadId, parentMsgId)
    ? null
    : await ctx.threadManager.findToolCall(parentMsgId, block.name, inputJson);

  if (existingTC) {
    log.debug('Dedup: found existing ToolCall in DB (resume re-send)', {
      namespace: 'agent',
      threadId,
      tool: block.name,
      existingId: existingTC.id,
    });
    seen.set(block.id, existingTC.id);
    ctx.state.rememberToolCall(threadId, existingTC.id, block.name);
    return;
  }

  const toolCallId = await ctx.threadManager.insertToolCall({
    messageId: parentMsgId,
    name: block.name,
    input: inputJson,
    parentToolCallId,
  });
  seen.set(block.id, toolCallId);
  ctx.state.rememberToolCall(threadId, toolCallId, block.name);

  await ctx.emitWS(threadId, 'agent:tool_call', {
    toolCallId,
    messageId: parentMsgId,
    name: block.name,
    input: block.input,
    parentToolCallId: parentToolCallId ?? undefined,
  });
}

/** Move the thread to `waiting` through the status machine; the new status. */
async function transitionToWaiting(
  ctx: MessageHandlerContext,
  threadId: string,
): Promise<{ from: ThreadStatus; status: ThreadStatus }> {
  // SAFETY: threads.status is only written from thread state machine results (or the
  // 'running' default here), so the stored string is a ThreadStatus.
  const currentStatus = ((await ctx.threadManager.getThread(threadId))?.status ??
    'running') as ThreadStatus;
  const { status } = transitionStatus(threadId, { type: 'WAIT' }, currentStatus);
  return { from: currentStatus, status };
}

/** AskUserQuestion / ExitPlanMode: the agent waits for the user's answer or plan approval. */
async function waitForUserInput(
  ctx: MessageHandlerContext,
  threadId: string,
  block: ToolUseBlock,
  reason: 'question' | 'plan',
): Promise<void> {
  const question = reason === 'question';
  log.info(`${block.name} detected — transitioning to waiting`, {
    ...(await ctx.threadCtx(threadId)),
    previousPendingInput: ctx.state.pendingUserInput.get(threadId) ?? 'none',
    ...(question ? { inputPreview: JSON.stringify(block.input).slice(0, 300) } : null),
  });
  ctx.state.pendingUserInput.set(threadId, reason);
  const { from, status } = await transitionToWaiting(ctx, threadId);
  log.debug(`${block.name} status transition`, {
    namespace: 'agent',
    threadId,
    from,
    to: status,
  });
  await ctx.threadManager.updateThread(threadId, { status });
  await ctx.emitWS(threadId, 'agent:status', { status, waitingReason: reason });
}

/**
 * In confirmEdit mode, the preToolUseHook pauses the SDK for
 * Edit/Write/Bash/NotebookEdit until the user approves. Transition
 * the thread to "waiting" immediately when we see the tool_use block
 * so the client can show the PermissionApprovalCard.
 */
async function waitForPermission(
  ctx: MessageHandlerContext,
  scope: ToolUseScope,
  block: ToolUseBlock,
): Promise<void> {
  const { threadId } = scope;
  const dbToolCallId = scope.seen.get(block.id);
  log.info(`confirmEdit: ${block.name} detected — transitioning to waiting`, {
    ...(await ctx.threadCtx(threadId)),
    tool: block.name,
    toolCallId: dbToolCallId ?? 'unknown',
  });
  const serializedInput = serializeToolInput(block.name, block.input);
  ctx.state.pendingPermissionRequest.set(threadId, {
    toolName: block.name,
    toolUseId: block.id,
    toolInput: serializedInput,
  });
  const { status } = await transitionToWaiting(ctx, threadId);
  await ctx.threadManager.updateThread(threadId, { status });
  await ctx.emitWS(threadId, 'agent:status', {
    status,
    waitingReason: 'permission',
    permissionRequest: { toolName: block.name, toolInput: serializedInput },
  });
}

/** Track whether this tool call means the agent is waiting for the user. */
async function trackWaitingState(
  ctx: MessageHandlerContext,
  scope: ToolUseScope,
  block: ToolUseBlock,
): Promise<void> {
  const { threadId } = scope;
  if (block.name === 'AskUserQuestion') {
    await waitForUserInput(ctx, threadId, block, 'question');
  } else if (block.name === 'ExitPlanMode') {
    await waitForUserInput(ctx, threadId, block, 'plan');
  } else if (await isConfirmEditTool(ctx, threadId, block.name)) {
    await waitForPermission(ctx, scope, block);
  } else {
    if (ctx.state.pendingUserInput.has(threadId)) {
      log.warn(
        'BUG-HUNT: Clearing pendingUserInput due to non-interactive tool call — may cause plan/question auto-continue',
        {
          ...(await ctx.threadCtx(threadId)),
          tool: block.name,
          wasPending: ctx.state.pendingUserInput.get(threadId),
        },
      );
    }
    ctx.state.pendingUserInput.delete(threadId);
  }
}

async function handleToolUseBlock(
  ctx: MessageHandlerContext,
  scope: ToolUseScope,
  block: ToolUseBlock,
): Promise<void> {
  const { threadId } = scope;
  if (skipToolUse(ctx, scope, block)) return;

  log.info(`tool_use: ${block.name}`, {
    ...(await ctx.threadCtx(threadId)),
    tool: block.name,
  });
  recordBashCheck(threadId, block);
  log.debug('tool_use input', {
    namespace: 'agent',
    threadId,
    tool: block.name,
    input: JSON.stringify(block.input),
  });

  const parentMsgId = await ensureParentMessage(ctx, scope);
  await persistToolCall(ctx, scope, block, parentMsgId);

  // Track provider errors (rate limits / API errors rendered as a
  // `ProviderError` tool card). A still-pending error at result time
  // turns the run into `failed` instead of a misleading "completed".
  // Any other (real) tool call means the agent moved on, so clear it.
  if (block.name === 'ProviderError') {
    log.info('ProviderError detected — marking thread for provider-error failure', {
      ...(await ctx.threadCtx(threadId)),
    });
    recordProviderError(ctx, threadId, block);
  } else {
    ctx.state.providerErrorPending.delete(threadId);
  }

  await trackWaitingState(ctx, scope, block);

  // Reset currentAssistantMsgId — next CLI message's text should be a new DB message
  ctx.state.currentAssistantMsgId.delete(threadId);
}

/**
 * Handle the tool_use blocks of an assistant message (deduplicated —
 * streaming sends cumulative content), in order.
 */
export async function handleToolUseBlocks(
  ctx: MessageHandlerContext,
  threadId: string,
  msg: CLIMessage & { type: 'assistant' },
  cliMap: Map<string, string>,
): Promise<void> {
  // Register the map up front: `ownMessageIds` relies on every inserted tool
  // call being recorded here, even if a later block in this loop throws.
  let seen = ctx.state.processedToolUseIds.get(threadId);
  if (!seen) {
    seen = new Map<string, string>();
    ctx.state.processedToolUseIds.set(threadId, seen);
  }

  // Resolve parent_tool_use_id → DB parentToolCallId for subagent tool calls
  const parentToolCallId = msg.parent_tool_use_id
    ? (seen.get(msg.parent_tool_use_id) ?? null)
    : null;

  const scope: ToolUseScope = {
    threadId,
    cliMsgId: msg.message.id,
    cliMap,
    seen,
    parentToolCallId,
  };
  for (const block of msg.message.content) {
    if ('type' in block && block.type === 'tool_use') {
      await handleToolUseBlock(ctx, scope, block);
    }
  }
}
