/**
 * Create a thread that runs in its own sandbox (change thread-sandboxes).
 *
 * The server owns the whole flow so it works with the user's own runners
 * offline (e.g. from a phone): it writes the thread row itself (status
 * `setting_up`, mode `local` — the sandbox already isolates it), provisions the
 * sandbox in the background, and once the sandbox runner has the checkout it
 * marks the thread `pending` (as a ready worktree does) and sends the first
 * message there, which starts the agent. The server saves that first message
 * itself when it creates the thread, so it is in the conversation even when the
 * sandbox never comes up; the runner reuses it (`savedMessageId`) instead of
 * saving it again. A failure marks the thread `failed`.
 *
 * A thread whose sandbox failed before its agent ever started can be retried:
 * the user's next message provisions a new sandbox for the same thread and
 * starts the agent with the initial prompt plus that message. The two stay
 * separate messages in the conversation: the initial prompt is dated when the
 * thread was created, so it reads before the failure card and the new message
 * after it.
 */

import { err, ok, type Result, type ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import { sandboxMachineRequestSchema } from './launch-request-schema.js';
import { sandboxErrorEventData, type SandboxErrorEventData } from './sandbox-events.js';
import type {
  PreparedSandboxLaunch,
  SandboxLaunchRefusal,
  SandboxLaunchRequest,
} from './sandbox-launch.js';

/** Agent providers a sandbox can run (the LLM proxy's adapters). */
const SANDBOX_AGENT_PROVIDERS = new Set(['claude']);

const createSandboxThreadSchema = z
  .object({
    projectId: z.string().min(1),
    title: z.string().trim().max(200).optional(),
    prompt: z.string().min(1).max(500_000),
    // Only providers the LLM proxy holds a credential for can run in a sandbox.
    provider: z
      .string()
      .refine((p) => SANDBOX_AGENT_PROVIDERS.has(p), {
        message: 'This provider is not available in sandboxes yet; use Claude.',
      })
      .optional(),
    model: z.string().min(1).max(128).optional(),
    permissionMode: z.string().min(1).max(64).optional(),
    effort: z.string().min(1).max(32).optional(),
    // The branch the sandbox checks out (it keeps the remote's default when absent).
    baseBranch: z.string().trim().min(1).max(255).optional(),
    // Without a connection, the caller's project sandbox is used (project-sandboxes).
    sandbox: sandboxMachineRequestSchema.partial({ connectionId: true }).optional(),
  })
  // The compose payload carries more fields; only the ones above are used here,
  // plus the message extras forwarded below.
  .passthrough();

/** A follow-up written on a failed sandbox thread; it retries the sandbox. */
export const retrySandboxThreadSchema = z
  .object({
    content: z.string().min(1).max(500_000),
    provider: createSandboxThreadSchema.shape.provider,
    model: z.string().min(1).max(128).optional(),
    permissionMode: z.string().min(1).max(64).optional(),
    effort: z.string().min(1).max(32).optional(),
  })
  .passthrough();

/** Message fields forwarded verbatim; the runner validates them. */
const FORWARDED_MESSAGE_FIELDS = [
  'images',
  'fileReferences',
  'symbolReferences',
  'allowedTools',
  'disallowedTools',
] as const;

export interface SandboxThreadFailure {
  status: 400 | 404 | 409;
  code: string;
  message: string;
}

export interface NewSandboxThreadRow {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  mode: 'local';
  runtime: 'sandbox';
  status: 'setting_up';
  stage: 'in_progress';
  provider?: string;
  model?: string;
  permissionMode?: string;
  baseBranch?: string;
  initialPrompt: string;
  source: 'web';
  createdAt: string;
  updatedAt: string;
}

/** What a retry needs to know about the thread. */
export interface RetryableSandboxThread {
  projectId: string;
  runtime?: string | null;
  status: string;
  sessionId?: string | null;
  initialPrompt?: string | null;
  baseBranch?: string | null;
  createdAt?: string;
}

export interface SandboxThreadDeps {
  findOwnedProject(userId: string, projectId: string): Promise<{ path: string } | null>;
  /** The caller's sandbox for the project (project-sandboxes), or null when none. */
  projectSandbox(
    userId: string,
    projectId: string,
  ): Promise<{ connectionId: string; sizeId: string } | null>;
  prepare(req: SandboxLaunchRequest): Promise<Result<PreparedSandboxLaunch, SandboxLaunchRefusal>>;
  insertThread(row: NewSandboxThreadRow): Promise<void>;
  loadThread(threadId: string): Promise<unknown>;
  /** The caller's own thread, or null (another user's thread is not found). */
  findOwnedThread(userId: string, threadId: string): Promise<RetryableSandboxThread | null>;
  /** The machine the thread's last sandbox used, so a retry provisions the same. */
  previousSandbox(
    threadId: string,
  ): Promise<{ connectionId: string; sizeId: string | null; repoUrl: string | null } | null>;
  /**
   * Save the thread's first user message, dated `timestamp`, unless the thread
   * already has a message. The saved message's id, or null when nothing was
   * saved. Never throws.
   */
  saveFirstMessage(input: FirstMessage): Promise<string | null>;
  /** A retry started: `failed` → `setting_up`. */
  markSettingUp(threadId: string): Promise<void>;
  /** The sandbox is ready: `setting_up` → `pending`, so the agent can start. */
  markReady(threadId: string): Promise<void>;
  /** Mark the thread failed and post the failure as a card in it. */
  markFailed(threadId: string, failure: SandboxErrorEventData): Promise<void>;
  sendMessage(input: {
    userId: string;
    threadId: string;
    body: Record<string, unknown>;
  }): ResultAsync<void, string>;
  newId(): string;
  now?: () => string;
}

type SandboxThreadInput = z.infer<typeof createSandboxThreadSchema>;

export interface FirstMessage {
  userId: string;
  threadId: string;
  content: string;
  timestamp: string;
  images?: unknown[];
  model?: string;
  permissionMode?: string;
  effort?: string;
}

function parseSandboxThread(payload: unknown): Result<SandboxThreadInput, SandboxThreadFailure> {
  const parsed = createSandboxThreadSchema.safeParse(payload);
  if (parsed.success) return ok(parsed.data);
  return err({
    status: 400,
    code: 'invalid',
    message: parsed.error.issues[0]?.message ?? 'Invalid sandbox thread',
  });
}

function newSandboxThreadRow(
  threadId: string,
  userId: string,
  input: SandboxThreadInput,
  createdAt: string,
): NewSandboxThreadRow {
  return {
    id: threadId,
    projectId: input.projectId,
    userId,
    title: input.title || input.prompt.slice(0, 80),
    mode: 'local',
    runtime: 'sandbox',
    status: 'setting_up',
    stage: 'in_progress',
    provider: input.provider,
    model: input.model,
    permissionMode: input.permissionMode,
    baseBranch: input.baseBranch,
    initialPrompt: input.prompt,
    source: 'web',
    createdAt,
    updatedAt: createdAt,
  };
}

/** The first message: the prompt, the agent settings and the forwarded extras. */
function firstMessageBody(input: SandboxThreadInput, payload: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = { content: input.prompt };
  for (const key of ['provider', 'model', 'permissionMode', 'effort'] as const) {
    if (input[key]) body[key] = input[key];
  }
  const extras = payload as Record<string, unknown>;
  for (const key of FORWARDED_MESSAGE_FIELDS) {
    if (extras[key] !== undefined) body[key] = extras[key];
  }
  return body;
}

/** The never-answered initial prompt, unless the user just re-sent it. */
function unansweredInitialPrompt(
  thread: RetryableSandboxThread,
  input: z.infer<typeof retrySandboxThreadSchema>,
): string | null {
  const initial = thread.initialPrompt?.trim();
  return initial && initial !== input.content.trim() ? initial : null;
}

/**
 * The retried first message: what the user wrote, with the never-answered
 * initial prompt ahead of it for the agent only (it is its own message).
 */
function retryMessageBody(
  input: z.infer<typeof retrySandboxThreadSchema>,
  initialPrompt: string | null,
): Record<string, unknown> {
  return initialPrompt ? { ...input, precedingPrompt: initialPrompt } : { ...input };
}

/**
 * Only a sandbox that failed before its agent started can be retried: once
 * there is a session, follow-ups go to the sandbox runner (woken on demand).
 */
function checkRetryable(
  thread: RetryableSandboxThread | null,
): Result<RetryableSandboxThread, SandboxThreadFailure> {
  if (!thread) return err({ status: 404, code: 'not-found', message: 'Thread not found' });
  if (thread.runtime !== 'sandbox' || thread.status !== 'failed' || thread.sessionId) {
    return err({
      status: 409,
      code: 'sandbox-not-retryable',
      message: 'Only a sandbox thread whose setup failed can be retried.',
    });
  }
  return ok(thread);
}

/** Threads with a retry being prepared, so a double submit starts one sandbox. */
const retriesInFlight = new Set<string>();

export function createSandboxThreadLauncher(deps: SandboxThreadDeps) {
  const now = deps.now ?? (() => new Date().toISOString());

  async function runInBackground(
    userId: string,
    threadId: string,
    launch: PreparedSandboxLaunch,
    body: Record<string, unknown>,
  ): Promise<void> {
    const provisioned = await launch.provision();
    if (provisioned.isOk()) {
      // Like a ready worktree: the agent may only start from `pending`, so the
      // thread leaves `setting_up` before its first message is sent.
      await deps.markReady(threadId);
    }
    const started = provisioned.isErr()
      ? err(sandboxErrorEventData('setup', provisioned.error))
      : (await deps.sendMessage({ userId, threadId, body })).mapErr((message) =>
          sandboxErrorEventData('start', `The agent could not be started: ${message}`),
        );
    if (started.isOk()) {
      metric('thread_sandboxes.threads_started', 1);
      return;
    }
    log.warn('Sandbox thread could not start', {
      namespace: 'thread-sandboxes',
      threadId,
      phase: started.error.phase,
      kind: started.error.kind,
      error: started.error.message,
    });
    metric('thread_sandboxes.threads_failed', 1, {
      attributes: { phase: started.error.phase, kind: started.error.kind ?? 'unknown' },
    });
    await deps.markFailed(threadId, started.error);
  }

  /**
   * The connection and size to provision: the ones the request names, else the
   * caller's project sandbox. The launch re-checks that the connection is theirs.
   */
  async function resolveMachine(
    userId: string,
    input: SandboxThreadInput,
  ): Promise<Result<{ connectionId: string; sizeId?: string }, SandboxThreadFailure>> {
    const requested = input.sandbox?.connectionId;
    if (requested) return ok({ connectionId: requested, sizeId: input.sandbox?.sizeId });
    const configured = await deps.projectSandbox(userId, input.projectId);
    if (!configured) {
      return err({
        status: 409,
        code: 'project-sandbox-not-configured',
        message: 'This project has no sandbox configured. Choose one in the project settings.',
      });
    }
    return ok({
      connectionId: configured.connectionId,
      sizeId: input.sandbox?.sizeId ?? configured.sizeId,
    });
  }

  function startInBackground(
    userId: string,
    threadId: string,
    launch: PreparedSandboxLaunch,
    body: Record<string, unknown>,
  ): Promise<void> {
    return runInBackground(userId, threadId, launch, body).catch((error) => {
      log.error('Sandbox thread launch crashed', {
        namespace: 'thread-sandboxes',
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** The machine a retry provisions: the thread's last one, else the project's sandbox. */
  async function retryMachine(
    userId: string,
    threadId: string,
    projectId: string,
  ): Promise<
    Result<{ connectionId: string; sizeId?: string; repoUrl?: string }, SandboxThreadFailure>
  > {
    const previous = await deps.previousSandbox(threadId);
    if (previous) {
      return ok({
        connectionId: previous.connectionId,
        sizeId: previous.sizeId ?? undefined,
        repoUrl: previous.repoUrl ?? undefined,
      });
    }
    const configured = await deps.projectSandbox(userId, projectId);
    if (configured) return ok(configured);
    return err({
      status: 409,
      code: 'project-sandbox-not-configured',
      message: 'This project has no sandbox configured. Choose one in the project settings.',
    });
  }

  /**
   * The never-answered initial prompt, saved as the first message of a thread
   * created before the server saved first messages (it has none yet).
   */
  async function saveUnansweredInitialPrompt(
    userId: string,
    threadId: string,
    thread: RetryableSandboxThread,
    input: z.infer<typeof retrySandboxThreadSchema>,
  ): Promise<string | null> {
    const initialPrompt = unansweredInitialPrompt(thread, input);
    if (!initialPrompt) return null;
    await deps.saveFirstMessage({
      userId,
      threadId,
      content: initialPrompt,
      timestamp: thread.createdAt ?? now(),
    });
    return initialPrompt;
  }

  async function prepareRetry(
    userId: string,
    threadId: string,
    payload: unknown,
  ): Promise<Result<{ thread: unknown; started: Promise<void> }, SandboxThreadFailure>> {
    const parsed = retrySandboxThreadSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        status: 400,
        code: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'Invalid message',
      });
    }
    const retryable = checkRetryable(await deps.findOwnedThread(userId, threadId));
    if (retryable.isErr()) return err(retryable.error);
    const thread = retryable.value;
    const project = await deps.findOwnedProject(userId, thread.projectId);
    if (!project) return err({ status: 404, code: 'not-found', message: 'Project not found' });
    const machine = await retryMachine(userId, threadId, thread.projectId);
    if (machine.isErr()) return err(machine.error);

    const launch = await deps.prepare({
      userId,
      threadId,
      projectId: thread.projectId,
      projectPath: project.path,
      branch: thread.baseBranch ?? undefined,
      ...machine.value,
    });
    if (launch.isErr()) return err({ status: 409, ...launch.error });

    const initialPrompt = await saveUnansweredInitialPrompt(userId, threadId, thread, parsed.data);
    await deps.markSettingUp(threadId);
    metric('thread_sandboxes.threads_retried', 1);
    const started = startInBackground(
      userId,
      threadId,
      launch.value,
      retryMessageBody(parsed.data, initialPrompt),
    );
    return ok({ thread: await deps.loadThread(threadId), started });
  }

  return {
    /**
     * Provision a new sandbox for a thread whose setup failed and start its
     * agent with the initial prompt plus the message the user just wrote.
     * `started` settles like {@link create}'s.
     */
    async retry(
      userId: string,
      threadId: string,
      payload: unknown,
    ): Promise<Result<{ thread: unknown; started: Promise<void> }, SandboxThreadFailure>> {
      if (retriesInFlight.has(threadId)) {
        return err({
          status: 409,
          code: 'sandbox-retry-in-progress',
          message: 'This sandbox is already being retried.',
        });
      }
      retriesInFlight.add(threadId);
      try {
        return await prepareRetry(userId, threadId, payload);
      } finally {
        retriesInFlight.delete(threadId);
      }
    },

    /**
     * Validate, create the thread and start its sandbox. `started` settles when
     * the agent was started (or the thread was marked failed); callers do not
     * need to await it.
     */
    async create(
      userId: string,
      payload: unknown,
    ): Promise<Result<{ thread: unknown; started: Promise<void> }, SandboxThreadFailure>> {
      const parsed = parseSandboxThread(payload);
      if (parsed.isErr()) return err(parsed.error);
      const input = parsed.value;
      const project = await deps.findOwnedProject(userId, input.projectId);
      if (!project) return err({ status: 404, code: 'not-found', message: 'Project not found' });

      const machine = await resolveMachine(userId, input);
      if (machine.isErr()) return err(machine.error);

      const threadId = deps.newId();
      const launch = await deps.prepare({
        userId,
        threadId,
        projectId: input.projectId,
        projectPath: project.path,
        branch: input.baseBranch,
        ...machine.value,
        repoUrl: input.sandbox?.repoUrl,
      });
      if (launch.isErr()) return err({ status: 409, ...launch.error });

      const createdAt = now();
      await deps.insertThread(newSandboxThreadRow(threadId, userId, input, createdAt));
      const body = firstMessageBody(input, payload);
      const savedMessageId = await deps.saveFirstMessage({
        userId,
        threadId,
        content: input.prompt,
        timestamp: createdAt,
        images: Array.isArray(body.images) ? body.images : undefined,
        model: input.model,
        permissionMode: input.permissionMode,
        effort: input.effort,
      });
      if (savedMessageId) body.savedMessageId = savedMessageId;

      const started = startInBackground(userId, threadId, launch.value, body);
      return ok({ thread: await deps.loadThread(threadId), started });
    },
  };
}
