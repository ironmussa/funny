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
import type { JsonObject, JsonValue } from '@funny/shared/json';

import type { NativeGitStatusState } from '../git-status-state';

const THREAD_STATUSES: ReadonlySet<string> = new Set<ThreadStatus>([
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
const GIT_STATES: ReadonlySet<string> = new Set<GitStatusInfo['state']>([
  'dirty',
  'unpushed',
  'pushed',
  'merged',
  'clean',
]);

function isThreadStatus(status: string): status is ThreadStatus {
  return THREAD_STATUSES.has(status);
}

function isGitState(state: string): state is GitStatusInfo['state'] {
  return GIT_STATES.has(state);
}

/** A realtime event's payload fields (it arrived as JSON), read before they are checked. */
type EventFields = JsonObject;

/** One field of a realtime event's payload, or the payload itself, before it is checked. */
type EventValue = JsonValue | undefined;

function isEventFields<T>(value: T): value is T & EventFields {
  return typeof value === 'object' && value !== null;
}

function isString(value: EventValue): value is string {
  return typeof value === 'string';
}

function isNumber(value: EventValue): value is number {
  return typeof value === 'number';
}

function isBoolean(value: EventValue): value is boolean {
  return typeof value === 'boolean';
}

function record(value: EventValue): EventFields {
  return isEventFields(value) ? value : {};
}

/** The event's payload fields; `{}` when the payload is not an object. */
function eventFields(event: RealtimeEvent): EventFields {
  return isEventFields(event.data) ? event.data : {};
}

function text(value: EventValue): string | undefined {
  return isString(value) ? value : undefined;
}

function eventIdentity(event: RealtimeEvent, data: EventFields): string {
  const explicit = text(data.eventId) ?? text(data.id);
  if (explicit) return explicit;
  return `${event.type}:${text(data.messageId) ?? text(data.toolCallId) ?? ''}:${JSON.stringify(data)}`;
}

function pendingPermission(value: EventValue): PendingPermissionRequest | null {
  const data = record(value);
  const required = ['requestId', 'threadId', 'runId', 'toolCallId', 'toolName', 'requestedAt'];
  if (!required.every((key) => isString(data[key]))) return null;
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

function gitStatus(value: EventValue): GitStatusInfo | null {
  const data = record(value);
  if (
    !isString(data.threadId) ||
    !isString(data.branchKey) ||
    !isString(data.state) ||
    !isGitState(data.state) ||
    !isNumber(data.dirtyFileCount) ||
    !isNumber(data.unpushedCommitCount) ||
    !isNumber(data.unpulledCommitCount) ||
    !isBoolean(data.hasRemoteBranch) ||
    !isBoolean(data.isMergedIntoBase) ||
    !isNumber(data.linesAdded) ||
    !isNumber(data.linesDeleted)
  )
    return null;
  return {
    threadId: data.threadId,
    branchKey: data.branchKey,
    state: data.state,
    dirtyFileCount: data.dirtyFileCount,
    unpushedCommitCount: data.unpushedCommitCount,
    unpulledCommitCount: data.unpulledCommitCount,
    hasRemoteBranch: data.hasRemoteBranch,
    isMergedIntoBase: data.isMergedIntoBase,
    linesAdded: data.linesAdded,
    linesDeleted: data.linesDeleted,
    ...(isNumber(data.prNumber) ? { prNumber: data.prNumber } : null),
    ...(isString(data.prUrl) ? { prUrl: data.prUrl } : null),
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
  const nextRevision = (key: string, provided: EventValue): number => {
    const numeric = isNumber(provided) ? provided : undefined;
    const next = numeric ?? (revisions.get(key) ?? 0) + 1;
    revisions.set(key, Math.max(next, revisions.get(key) ?? 0));
    return next;
  };
  return (event: RealtimeEvent): void => {
    const data = eventFields(event);
    const threadId = event.threadId || text(data.threadId) || '';
    if (!threadId) return;
    if (event.type === 'agent:message') {
      const messageId = text(data.messageId);
      const content = text(data.content);
      if (!messageId || content === undefined) return;
      // SAFETY: `agent:message` events carry the persisted message's MessageRole in `role`;
      // the native client keeps the web client's pass-through instead of rejecting a new role.
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
        input: isString(data.input) ? data.input : JSON.stringify(data.input ?? {}),
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
      if (status && isThreadStatus(status)) {
        options.workspace.getState().setRun(threadId, {
          runId: text(data.runId) ?? undefined,
          status,
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
      const data = eventFields(event);
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
      const statuses = eventFields(event).statuses;
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
