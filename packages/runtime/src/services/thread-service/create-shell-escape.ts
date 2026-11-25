/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created
 */
/** `!cmd` initial prompts: run the command locally and store an already-completed thread. */

import { getCurrentBranch } from '@funny/core/git';
import type { AgentModel, PermissionMode, ImageAttachment } from '@funny/shared';

import type { RuntimeThreadInsert } from '../server-interfaces.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import { wsBroker } from '../ws-broker.js';
import {
  baseProjectThreadRow,
  type CreateAndStartThreadParams,
  type ProjectThreadContext,
} from './create-context.js';
import { ThreadServiceError } from './helpers.js';
import { executeShellEscape, formatShellEscapeOutput } from './shell-escape.js';

/** `!cmd` initial prompts run locally and produce an already-completed thread. */
export async function createShellEscapeProjectThread(
  ctx: ProjectThreadContext,
  shellCommand: string,
) {
  if (!shellCommand) {
    throw new ThreadServiceError('Shell escape requires a command after "!".', 400);
  }
  const { params, defaults } = ctx;

  const branchResult = await getCurrentBranch(ctx.projectPath);
  const currentBranch = branchResult.isOk() ? branchResult.value : undefined;
  const thread = {
    ...baseProjectThreadRow(ctx),
    mode: 'local' as const,
    runtime: 'local' as const,
    status: 'completed' as const,
    branch: currentBranch,
    baseBranch: ctx.resolvedBaseBranch || currentBranch,
    worktreePath: undefined,
    fileCheckpointingEnabled: 0,
  };

  await createCompletedShellEscapeThread({
    thread,
    threadId: ctx.threadId,
    projectId: ctx.projectId,
    userId: params.userId,
    cwd: ctx.projectPath,
    command: shellCommand,
    prompt: params.prompt,
    images: params.images,
    model: defaults.model,
    permissionMode: defaults.permissionMode,
    effort: params.effort,
  });

  return thread;
}

/** `!cmd` initial prompts in a scratch thread run locally and complete immediately. */
export async function createScratchShellEscapeThread<T extends RuntimeThreadInsert>(
  thread: T,
  shellCommand: string,
  ctx: {
    params: CreateAndStartThreadParams;
    cwd: string;
    model: AgentModel;
    permissionMode: PermissionMode;
  },
) {
  if (!shellCommand) {
    throw new ThreadServiceError('Shell escape requires a command after "!".', 400);
  }
  const completedThread = { ...thread, status: 'completed' as const, fileCheckpointingEnabled: 0 };
  await createCompletedShellEscapeThread({
    thread: completedThread,
    threadId: thread.id,
    projectId: '',
    userId: ctx.params.userId,
    cwd: ctx.cwd,
    command: shellCommand,
    prompt: ctx.params.prompt,
    images: ctx.params.images,
    model: ctx.model,
    permissionMode: ctx.permissionMode,
    effort: ctx.params.effort,
  });
  return completedThread;
}

async function createCompletedShellEscapeThread(args: {
  thread: RuntimeThreadInsert;
  threadId: string;
  projectId: string;
  userId: string;
  cwd: string;
  command: string;
  prompt: string;
  images?: ImageAttachment[];
  model: AgentModel;
  permissionMode: PermissionMode;
  effort?: string;
}) {
  await tm.createThread(args.thread);

  const userMessageId = await tm.insertMessage({
    threadId: args.threadId,
    role: 'user',
    content: args.prompt,
    images: args.images?.length ? JSON.stringify(args.images) : null,
    model: args.model,
    permissionMode: args.permissionMode,
    effort: args.effort ?? null,
  });
  const assistantMessageId = await tm.insertMessage({
    threadId: args.threadId,
    role: 'assistant',
    content: '',
  });
  const toolInput = { command: args.command };
  const toolCallId = await tm.insertToolCall({
    messageId: assistantMessageId,
    name: 'Bash',
    input: JSON.stringify(toolInput),
    author: 'shell',
  });

  threadEventBus.emit('thread:created', {
    threadId: args.threadId,
    projectId: args.projectId,
    userId: args.userId,
    cwd: args.cwd,
    worktreePath: null,
    stage: 'in_progress' as const,
    status: 'completed',
  });

  const result = await executeShellEscape(args.command, args.cwd);
  const output = formatShellEscapeOutput(result);
  await tm.updateToolCallOutput(toolCallId, output);

  wsBroker.emitToUser(args.userId, {
    type: 'agent:message',
    threadId: args.threadId,
    data: { messageId: userMessageId, role: 'user', content: args.prompt },
  });
  wsBroker.emitToUser(args.userId, {
    type: 'agent:tool_call',
    threadId: args.threadId,
    data: {
      toolCallId,
      messageId: assistantMessageId,
      name: 'Bash',
      input: toolInput,
      author: 'shell',
    },
  });
  wsBroker.emitToUser(args.userId, {
    type: 'agent:tool_output',
    threadId: args.threadId,
    data: { toolCallId, output },
  });
}
