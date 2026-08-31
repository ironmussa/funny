import type {
  DiagnosticService,
  RealtimeActionPorts,
  RealtimeEvent,
  StoreApi,
  ThreadNavigationState,
  ThreadWorkspaceState,
} from '@funny/client-core';
import type {
  GitStatusInfo,
  MessageRole,
  PendingPermissionRequest,
  ThreadStatus,
  ToolCall,
} from '@funny/shared';

import type { NativeGitStatusState } from '../git-status-state';

const THREAD_STATUSES = new Set<ThreadStatus>([
  'setting_up',
  'idle',
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);
const GIT_STATES = new Set<GitStatusInfo['state']>([
  'dirty',
  'unpushed',
  'pushed',
  'merged',
  'clean',
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function eventIdentity(event: RealtimeEvent, data: Record<string, unknown>): string {
  const explicit = text(data.eventId) ?? text(data.id);
  if (explicit) return explicit;
  return `${event.type}:${text(data.messageId) ?? text(data.toolCallId) ?? ''}:${JSON.stringify(data)}`;
}

function pendingPermission(value: unknown): PendingPermissionRequest | null {
  const data = record(value);
  const required = ['requestId', 'threadId', 'runId', 'toolCallId', 'toolName', 'requestedAt'];
  if (!required.every((key) => typeof data[key] === 'string')) return null;
  return {
    requestId: String(data.requestId),
    threadId: String(data.threadId),
    runId: String(data.runId),
    transport: 'codex-acp',
    toolCallId: String(data.toolCallId),
    toolName: String(data.toolName),
    toolInput: text(data.toolInput),
    canAlwaysAllow: data.canAlwaysAllow === true,
    canDeny: data.canDeny === true,
    requestedAt: String(data.requestedAt),
  };
}

function gitStatus(value: unknown): GitStatusInfo | null {
  const data = record(value);
  if (
    typeof data.threadId !== 'string' ||
    typeof data.branchKey !== 'string' ||
    typeof data.state !== 'string' ||
    !GIT_STATES.has(data.state as GitStatusInfo['state']) ||
    typeof data.dirtyFileCount !== 'number' ||
    typeof data.unpushedCommitCount !== 'number' ||
    typeof data.unpulledCommitCount !== 'number' ||
    typeof data.hasRemoteBranch !== 'boolean' ||
    typeof data.isMergedIntoBase !== 'boolean' ||
    typeof data.linesAdded !== 'number' ||
    typeof data.linesDeleted !== 'number'
  )
    return null;
  return {
    threadId: data.threadId,
    branchKey: data.branchKey,
    state: data.state as GitStatusInfo['state'],
    dirtyFileCount: data.dirtyFileCount,
    unpushedCommitCount: data.unpushedCommitCount,
    unpulledCommitCount: data.unpulledCommitCount,
    hasRemoteBranch: data.hasRemoteBranch,
    isMergedIntoBase: data.isMergedIntoBase,
    linesAdded: data.linesAdded,
    linesDeleted: data.linesDeleted,
    ...(typeof data.prNumber === 'number' ? { prNumber: data.prNumber } : null),
    ...(typeof data.prUrl === 'string' ? { prUrl: data.prUrl } : null),
    ...(data.prState === 'OPEN' || data.prState === 'MERGED' || data.prState === 'CLOSED'
      ? { prState: data.prState }
      : null),
  };
}

function createAgentAction(options: {
  workspace: StoreApi<ThreadWorkspaceState>;
  diagnostics: DiagnosticService;
}) {
  const revisions = new Map<string, number>();
  const nextRevision = (key: string, provided: unknown): number => {
    const numeric = typeof provided === 'number' ? provided : undefined;
    const next = numeric ?? (revisions.get(key) ?? 0) + 1;
    revisions.set(key, Math.max(next, revisions.get(key) ?? 0));
    return next;
  };
  return (event: RealtimeEvent): void => {
    const data = record(event.data);
    const threadId = event.threadId || text(data.threadId) || '';
    if (!threadId) return;
    if (event.type === 'agent:message') {
      const messageId = text(data.messageId);
      const content = text(data.content);
      if (!messageId || content === undefined) return;
      const role = (text(data.role) ?? 'assistant') as MessageRole;
      if (role === 'assistant') {
        options.workspace.getState().applyStreamingDelta({
          eventId: eventIdentity(event, data),
          threadId,
          messageId,
          revision: nextRevision(`${threadId}:${messageId}`, data.revision ?? data.sequence),
          content,
          mode: 'replace',
          timestamp: text(data.timestamp),
        });
      } else {
        options.workspace.getState().upsertDurableMessage(threadId, {
          id: messageId,
          threadId,
          role,
          content,
          timestamp: text(data.timestamp) ?? new Date(0).toISOString(),
          author: text(data.author),
        });
      }
      return;
    }
    if (event.type === 'agent:tool_call') {
      const toolCallId = text(data.toolCallId);
      const messageId = text(data.messageId);
      const name = text(data.name);
      if (!toolCallId || !messageId || !name) return;
      const toolCall: ToolCall = {
        id: toolCallId,
        messageId,
        name,
        input: typeof data.input === 'string' ? data.input : JSON.stringify(data.input ?? {}),
        timestamp: text(data.timestamp),
        author: text(data.author),
        parentToolCallId: text(data.parentToolCallId),
      };
      options.workspace.getState().upsertToolCall(threadId, toolCall);
      return;
    }
    if (event.type === 'agent:tool_output') {
      const toolCallId = text(data.toolCallId);
      const output = text(data.output);
      if (toolCallId && output !== undefined) {
        options.workspace.getState().updateToolOutput(threadId, toolCallId, output);
      }
      return;
    }
    if (event.type === 'agent:status') {
      const status = text(data.status);
      if (status && THREAD_STATUSES.has(status as ThreadStatus)) {
        options.workspace.getState().setRun(threadId, {
          runId: text(data.runId) ?? undefined,
          status: status as ThreadStatus,
          error: text(data.error) ?? null,
        });
      }
      const permission = pendingPermission(data.pendingPermissionRequest);
      if (permission)
        options.workspace.getState().setPermission(threadId, { ...permission, status: 'active' });
      return;
    }
    if (event.type === 'agent:result') {
      const failed = data.status === 'failed' || data.status === 'error';
      options.workspace.getState().setRun(threadId, {
        runId: text(data.runId) ?? undefined,
        status: failed ? 'failed' : 'completed',
        error: text(data.error) ?? null,
      });
      return;
    }
    if (event.type === 'agent:error') {
      options.workspace
        .getState()
        .setRun(threadId, { status: 'failed', error: text(data.error) ?? 'Agent failed' });
      return;
    }
    options.diagnostics.report({
      capability: 'platform',
      operation: `realtime.unsupported.${event.type}`,
      error: new Error('Native MVP ignored an unsupported agent event'),
      optional: true,
    });
  };
}

export function createNativeRealtimeActions(options: {
  workspace: StoreApi<ThreadWorkspaceState>;
  navigation: StoreApi<ThreadNavigationState>;
  gitStatus: StoreApi<NativeGitStatusState>;
  diagnostics: DiagnosticService;
}): RealtimeActionPorts {
  const ignore = () => undefined;
  return {
    agent: createAgentAction(options),
    thread(event) {
      const data = record(event.data);
      if (event.type === 'thread:share-revoked') {
        options.navigation.getState().removeThread(event.threadId);
        options.workspace.getState().removeThread(event.threadId);
      } else if (event.type === 'thread:updated') {
        options.navigation.getState().patchThread(event.threadId, data);
      }
    },
    terminal: ignore,
    git(event) {
      if (event.type !== 'git:status') return;
      const statuses = record(event.data).statuses;
      if (!Array.isArray(statuses)) return;
      options.gitStatus.getState().replace(
        statuses.flatMap((value) => {
          const parsed = gitStatus(value);
          return parsed ? [parsed] : [];
        }),
      );
    },
    automation: ignore,
    pipeline: ignore,
    workflow: ignore,
    presence: ignore,
    testing: ignore,
    browserSession: ignore,
    infrastructure: ignore,
  };
}
