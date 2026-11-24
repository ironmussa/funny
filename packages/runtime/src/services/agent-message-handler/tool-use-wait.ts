/**
 * What a tool_use block means for the thread's wait state: a question or a
 * plan waits for the user, a confirmEdit tool waits for approval, any other
 * tool clears a pending interactive wait. Split out of
 * agent-message-handler.ts.
 */

import type { ThreadStatus } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { transitionStatus } from '../thread-status-machine.js';
import type { HandlerContext } from './context.js';
import { serializeToolInput } from './message-helpers.js';

/** Tools that require user approval in confirmEdit mode */
const CONFIRM_EDIT_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);

/** Check if the tool_use requires user approval (confirmEdit mode + file-editing tool) */
async function isConfirmEditTool(
  ctx: HandlerContext,
  threadId: string,
  toolName: string,
): Promise<boolean> {
  if (!CONFIRM_EDIT_TOOLS.has(toolName)) return false;
  const thread = await ctx.threadManager.getThread(threadId);
  return thread?.permissionMode === 'confirmEdit';
}

/** The thread's status after a WAIT from its current one. */
async function waitStatus(ctx: HandlerContext, threadId: string) {
  const currentStatus = (await ctx.threadManager.getThread(threadId))?.status ?? 'running';
  const { status } = transitionStatus(threadId, { type: 'WAIT' }, currentStatus as ThreadStatus);
  return { currentStatus, status };
}

async function waitForQuestion(
  ctx: HandlerContext,
  threadId: string,
  block: { input: unknown },
): Promise<void> {
  log.info('AskUserQuestion detected — transitioning to waiting', {
    ...(await ctx.threadCtx(threadId)),
    previousPendingInput: ctx.state.pendingUserInput.get(threadId) ?? 'none',
    inputPreview: JSON.stringify(block.input).slice(0, 300),
  });
  ctx.state.pendingUserInput.set(threadId, 'question');
  const { currentStatus, status } = await waitStatus(ctx, threadId);
  log.debug('AskUserQuestion status transition', {
    namespace: 'agent',
    threadId,
    from: currentStatus,
    to: status,
  });
  await ctx.threadManager.updateThread(threadId, { status });
  await ctx.emitWS(threadId, 'agent:status', { status, waitingReason: 'question' });
}

async function waitForPlan(ctx: HandlerContext, threadId: string): Promise<void> {
  log.info('ExitPlanMode detected — transitioning to waiting', {
    ...(await ctx.threadCtx(threadId)),
    previousPendingInput: ctx.state.pendingUserInput.get(threadId) ?? 'none',
  });
  ctx.state.pendingUserInput.set(threadId, 'plan');
  const { currentStatus, status } = await waitStatus(ctx, threadId);
  log.debug('ExitPlanMode status transition', {
    namespace: 'agent',
    threadId,
    from: currentStatus,
    to: status,
  });
  await ctx.threadManager.updateThread(threadId, { status });
  await ctx.emitWS(threadId, 'agent:status', { status, waitingReason: 'plan' });
}

/**
 * In confirmEdit mode, the preToolUseHook pauses the SDK for
 * Edit/Write/Bash/NotebookEdit until the user approves. Transition
 * the thread to "waiting" immediately when we see the tool_use block
 * so the client can show the PermissionApprovalCard.
 */
async function waitForEditApproval(
  ctx: HandlerContext,
  threadId: string,
  block: { id: string; name: string; input: unknown },
  dbToolCallId: string | undefined,
): Promise<void> {
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
  const { status } = await waitStatus(ctx, threadId);
  await ctx.threadManager.updateThread(threadId, { status });
  await ctx.emitWS(threadId, 'agent:status', {
    status,
    waitingReason: 'permission',
    permissionRequest: { toolName: block.name, toolInput: serializedInput },
  });
}

/** Track if this tool call means the agent is waiting for user input. */
export async function applyToolUseWaitState(
  ctx: HandlerContext,
  threadId: string,
  block: { id: string; name: string; input: unknown },
  seen: Map<string, string>,
): Promise<void> {
  if (block.name === 'AskUserQuestion') {
    await waitForQuestion(ctx, threadId, block);
  } else if (block.name === 'ExitPlanMode') {
    await waitForPlan(ctx, threadId);
  } else if (await isConfirmEditTool(ctx, threadId, block.name)) {
    await waitForEditApproval(ctx, threadId, block, seen.get(block.id));
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
