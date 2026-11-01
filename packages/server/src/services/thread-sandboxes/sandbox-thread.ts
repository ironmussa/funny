/**
 * Create a thread that runs in its own sandbox (change thread-sandboxes).
 *
 * The server owns the whole flow so it works with the user's own runners
 * offline (e.g. from a phone): it writes the thread row itself (status
 * `setting_up`, mode `local` — the sandbox already isolates it), provisions the
 * sandbox in the background, and once the sandbox runner has the checkout it
 * marks the thread `pending` (as a ready worktree does) and sends the first
 * message there, which starts the agent. A failure marks the
 * thread `failed` and the prompt stays on the thread as its initial prompt.
 */

import { err, ok, type Result, type ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
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
    sandbox: z
      .object({
        connectionId: z.string().min(1),
        sizeId: z.string().min(1).max(32).optional(),
        repoUrl: z.string().min(1).max(2048).optional(),
      })
      .strict(),
  })
  // The compose payload carries more fields; only the ones above are used here,
  // plus the message extras forwarded below.
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
  initialPrompt: string;
  source: 'web';
  createdAt: string;
  updatedAt: string;
}

export interface SandboxThreadDeps {
  findOwnedProject(userId: string, projectId: string): Promise<{ path: string } | null>;
  prepare(req: SandboxLaunchRequest): Promise<Result<PreparedSandboxLaunch, SandboxLaunchRefusal>>;
  insertThread(row: NewSandboxThreadRow): Promise<void>;
  loadThread(threadId: string): Promise<unknown>;
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

  return {
    /**
     * Validate, create the thread and start its sandbox. `started` settles when
     * the agent was started (or the thread was marked failed); callers do not
     * need to await it.
     */
    async create(
      userId: string,
      payload: unknown,
    ): Promise<Result<{ thread: unknown; started: Promise<void> }, SandboxThreadFailure>> {
      const parsed = createSandboxThreadSchema.safeParse(payload);
      if (!parsed.success) {
        return err({
          status: 400,
          code: 'invalid',
          message: parsed.error.issues[0]?.message ?? 'Invalid sandbox thread',
        });
      }
      const input = parsed.data;
      const project = await deps.findOwnedProject(userId, input.projectId);
      if (!project) return err({ status: 404, code: 'not-found', message: 'Project not found' });

      const threadId = deps.newId();
      const launch = await deps.prepare({
        userId,
        threadId,
        projectId: input.projectId,
        projectPath: project.path,
        connectionId: input.sandbox.connectionId,
        sizeId: input.sandbox.sizeId,
        repoUrl: input.sandbox.repoUrl,
      });
      if (launch.isErr()) return err({ status: 409, ...launch.error });

      const createdAt = now();
      await deps.insertThread({
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
        initialPrompt: input.prompt,
        source: 'web',
        createdAt,
        updatedAt: createdAt,
      });

      const body: Record<string, unknown> = { content: input.prompt };
      for (const key of ['provider', 'model', 'permissionMode', 'effort'] as const) {
        if (input[key]) body[key] = input[key];
      }
      const extras = payload as Record<string, unknown>;
      for (const key of FORWARDED_MESSAGE_FIELDS) {
        if (extras[key] !== undefined) body[key] = extras[key];
      }

      const started = runInBackground(userId, threadId, launch.value, body).catch((error) => {
        log.error('Sandbox thread launch crashed', {
          namespace: 'thread-sandboxes',
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return ok({ thread: await deps.loadThread(threadId), started });
    },
  };
}

export type SandboxThreadLauncher = ReturnType<typeof createSandboxThreadLauncher>;
