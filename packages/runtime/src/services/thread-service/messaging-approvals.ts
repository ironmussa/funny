/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Tool approvals and provider permission requests for a thread's agent, and the
 * saved "always allow" rules they create. Split out of messaging.ts.
 */

import type { AgentModel, AgentProvider, PermissionMode } from '@funny/shared';
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, DEFAULT_PROVIDER } from '@funny/shared/models';
import { ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { getPendingPermission, respondToPermission, startAgent } from '../agent-runner-control.js';
import { listPermissionRules } from '../permission-rules-client.js';
import { getServices } from '../service-registry.js';
import { resolveThreadCwd } from '../thread-context.js';
import * as tm from '../thread-manager.js';
import { wsBroker } from '../ws-broker.js';
import { ThreadServiceError, toThreadServiceError } from './helpers.js';

/**
 * Augment a list of allowedTools with tool names that have an "always allow"
 * rule for the given user + project. Lets the agent skip permission prompts
 * for tools the user previously approved.
 *
 * Returns a new array; the original is not mutated.
 */
export async function augmentAllowedToolsWithRules(
  userId: string,
  projectPath: string,
  allowedTools: string[] | undefined,
): Promise<string[] | undefined> {
  const rules = await listPermissionRules({ userId, projectPath });
  if (!rules.length) return allowedTools;
  const allowToolNames = new Set<string>();
  for (const rule of rules) {
    if (rule.decision === 'allow') {
      allowToolNames.add(rule.toolName);
    }
  }
  if (!allowToolNames.size) return allowedTools;
  const merged = new Set<string>(allowedTools ?? []);
  for (const t of allowToolNames) merged.add(t);
  return [...merged];
}

// ── Approve / Deny Tool ─────────────────────────────────────────

export interface ApproveToolParams {
  threadId: string;
  userId: string;
  toolName: string;
  approved: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** When 'always', persist a permission rule for this project. */
  scope?: 'once' | 'always';
  /** Optional explicit pattern; otherwise derived from toolInput for Bash. */
  pattern?: string;
  /** Original tool input (used to derive a Bash command prefix when needed). */
  toolInput?: string;
}

export interface RespondPermissionRequestParams {
  threadId: string;
  userId: string;
  requestId: string;
  decision: import('@funny/shared').PermissionDecision;
}

/** Heuristic: derive a Bash command prefix to use as a permission pattern. */
function deriveBashPrefix(toolInput: string | undefined): string | null {
  if (!toolInput) return null;
  const trimmed = toolInput.trim();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s+/)[0];
  return firstToken || null;
}

type ThreadRecord = NonNullable<Awaited<ReturnType<typeof tm.getThread>>>;
type PendingPermission = NonNullable<ReturnType<typeof getPendingPermission>>;

/** Tools granted on approval when the caller does not supply its own list. */
const DEFAULT_APPROVAL_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
  'NotebookEdit',
];

async function requireThread(threadId: string): Promise<ThreadRecord> {
  const thread = await tm.getThread(threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);
  return thread;
}

/** Resolve the thread's working directory via the scratch-aware predicate. */
async function resolveWorkdir(thread: ThreadRecord): Promise<string> {
  const project = thread.projectId
    ? await getServices().projects.getProject(thread.projectId)
    : null;
  const cwdResult = resolveThreadCwd(thread, project ? { path: project.path } : null);
  if (cwdResult.isErr()) throw new ThreadServiceError(cwdResult.error.message, 400);
  return cwdResult.value;
}

interface ApprovalRun {
  message: string;
  disallowedTools?: string[];
  allowedTools?: string[];
}

export function approveToolCall(params: ApproveToolParams): ResultAsync<void, ThreadServiceError> {
  return ResultAsync.fromPromise(approveToolCallImpl(params), toThreadServiceError);
}

async function approveToolCallImpl(params: ApproveToolParams): Promise<void> {
  const thread = await requireThread(params.threadId);
  const cwd = await resolveWorkdir(thread);
  const run = params.approved
    ? await buildApprovedRun(params, thread, cwd)
    : buildDeniedRun(params);
  const started = await startAgent(
    params.threadId,
    run.message,
    cwd,
    (thread.model as AgentModel) || DEFAULT_MODEL,
    (thread.permissionMode as PermissionMode) || DEFAULT_PERMISSION_MODE,
    undefined,
    run.disallowedTools,
    run.allowedTools,
    (thread.provider || DEFAULT_PROVIDER) as AgentProvider,
  );
  if (started.isErr()) throw new ThreadServiceError(started.error.message, 500);
}

function buildDeniedRun(params: ApproveToolParams): ApprovalRun {
  return {
    message: `The user denied permission to use ${params.toolName}. Please continue without it.`,
    disallowedTools: params.disallowedTools,
    allowedTools: params.allowedTools,
  };
}

async function buildApprovedRun(
  params: ApproveToolParams,
  thread: ThreadRecord,
  cwd: string,
): Promise<ApprovalRun> {
  const tools = params.allowedTools ? [...params.allowedTools] : [...DEFAULT_APPROVAL_TOOLS];
  if (!tools.includes(params.toolName)) {
    tools.push(params.toolName);
  }
  const projectPath = thread.worktreePath ?? cwd;
  // Persist "always allow in this project" rule when requested.
  if (params.scope === 'always') {
    await persistApprovalRule(params, projectPath);
  }
  return {
    message: `The user has approved the use of ${params.toolName}. Please proceed with using it.`,
    disallowedTools: params.disallowedTools?.filter((t) => t !== params.toolName),
    allowedTools: await augmentAllowedToolsWithRules(params.userId, projectPath, tools),
  };
}

function approvalRulePattern(params: ApproveToolParams): string | null {
  return params.pattern ?? (params.toolName === 'Bash' ? deriveBashPrefix(params.toolInput) : null);
}

async function persistApprovalRule(params: ApproveToolParams, projectPath: string): Promise<void> {
  const pattern = approvalRulePattern(params);
  try {
    const { createPermissionRule } = await import('../permission-rules-client.js');
    await createPermissionRule({
      userId: params.userId,
      projectPath,
      toolName: params.toolName,
      pattern,
      decision: 'allow',
    });
    log.info('approveToolCall: persisted always-allow rule', {
      namespace: 'thread-service',
      threadId: params.threadId,
      userId: params.userId,
      projectPath,
      toolName: params.toolName,
      pattern: pattern ?? '',
    });
  } catch (err) {
    // Don't block the approve flow on persistence failure; the
    // user can still re-approve next time.
    log.warn('approveToolCall: failed to persist always-allow rule', {
      namespace: 'thread-service',
      threadId: params.threadId,
      error: (err as Error)?.message,
    });
  }
}

/**
 * Answer a provider-native request in the process that created it. This path
 * intentionally never calls startAgent: doing so would turn a per-tool choice
 * into a new natural-language prompt and could approve the wrong operation.
 */
export function respondPermissionRequest(
  params: RespondPermissionRequestParams,
): ResultAsync<void, ThreadServiceError> {
  return ResultAsync.fromPromise(respondPermissionRequestImpl(params), toThreadServiceError);
}

async function respondPermissionRequestImpl(params: RespondPermissionRequestParams): Promise<void> {
  const thread = await requireThread(params.threadId);
  if (thread.userId !== params.userId) throw new ThreadServiceError('Access denied', 403);

  // The process lookup binds this decision to the current live request id and
  // supplies the only input that may be used to create an always-allow rule.
  const pending = getPendingPermission(params.threadId, params.requestId);
  if (!pending) throw new ThreadServiceError('This permission request is no longer active.', 409);

  if (params.decision === 'allow_always') {
    await persistStructuredAllowRule(params, thread, pending);
  }

  const accepted = await respondToPermission(params.threadId, params.requestId, params.decision);
  if (!accepted) throw new ThreadServiceError('This permission request is no longer active.', 409);

  await recordPermissionResolution(params);
  await markPermissionTurnResumed(params);
}

async function persistStructuredAllowRule(
  params: RespondPermissionRequestParams,
  thread: ThreadRecord,
  pending: PendingPermission,
): Promise<void> {
  const cwd = await resolveWorkdir(thread);
  const pattern = pending.toolName === 'Bash' ? deriveBashPrefix(pending.toolInput) : null;
  const { createPermissionRule } = await import('../permission-rules-client.js');
  const rule = await createPermissionRule({
    userId: params.userId,
    projectPath: thread.worktreePath ?? cwd,
    toolName: pending.toolName,
    pattern,
    decision: 'allow',
  });
  // The continuation is deliberately left live when persistence fails so
  // the card can offer a truthful one-time approval instead.
  if (!rule) {
    throw new ThreadServiceError(
      'Permanent approval could not be saved. You can still allow this action once.',
      503,
    );
  }
}

async function recordPermissionResolution(params: RespondPermissionRequestParams): Promise<void> {
  const persisted = await tm.resolvePendingPermissionRequest?.(params.requestId, params.decision);
  // The process accepts a request only once. Storage follows immediately so
  // reloads cannot revive the just-resolved card. A failed durable transition
  // is logged because the provider has already resumed and cannot be rolled
  // back safely.
  if (persisted === false) {
    log.warn('Structured permission resolved live but was already stale in storage', {
      namespace: 'thread-service',
      threadId: params.threadId,
      requestId: params.requestId,
    });
  }
}

async function markPermissionTurnResumed(params: RespondPermissionRequestParams): Promise<void> {
  // The provider is resuming the same live turn. Clear the actionable card
  // immediately instead of leaving the thread visibly waiting until its next
  // tool/result event arrives.
  await tm.updateThread(params.threadId, { status: 'running' });
  wsBroker.emitToUser(params.userId, {
    type: 'agent:status',
    threadId: params.threadId,
    data: {
      status: 'running',
      permissionApprovalCapability: { kind: 'structured', transport: 'codex-acp' },
    },
  });
}
