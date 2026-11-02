/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: application-service
 * @domain layer: application
 *
 * Provisions the sandbox a thread runs in (change thread-sandboxes). Provider
 * neutral: it only uses the contract, a provider connection and the template
 * manager.
 *
 *   provisioning → (installing) → connecting → (bootstrapping) → running
 *
 * States move only through events of the shared sandbox machine
 * (`@funny/shared/sandbox-machine`), applied atomically by the store.
 *
 * The preparation is an Effect program. Steps are lazy and run strictly in
 * order; the machine is a scoped resource destroyed on any failure *or*
 * interruption (the thread deleted mid-setup aborts `input.signal`). A ready
 * runner template is used when there is one; otherwise the runner is installed
 * on the fly while the template is built in the background for the next
 * thread. The runner enrolls itself with a single-use provisioning token and
 * becomes the `sandbox` runner of the thread.
 */

import { ACTIVE_SANDBOX_STATES } from '@funny/shared/sandbox-machine';
import { Effect, Exit } from 'effect';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import { mintLlmProxyToken } from '../llm-proxy/llm-proxy-tokens.js';
import type { ProvisionTokenError } from '../runner-provision-tokens.js';
import {
  resolveSandboxSize,
  type SandboxError,
  type SandboxHandle,
  type SandboxProvider,
  type TemplateRef,
} from './contract.js';
import { fromResult, runToResult } from './effect-bridge.js';
import { pollUntil } from './poll.js';
import type { RunnerBuild } from './runner-build.js';
import { runnerInstallCommand, startRunnerCommand } from './runner-install-script.js';
import { providerForConnection } from './sandbox-store-ops.js';
import type { RunnerTemplateManager } from './template-manager.js';
import {
  createThreadSandboxControl,
  DEFAULT_SANDBOX_LIFETIME_MS,
  exitFailure,
  providerCall,
  sandboxError,
  sandboxOps,
  type ThreadSandboxControlDeps,
} from './thread-sandbox-control.js';
import type { ThreadSandboxRow, ThreadSandboxState } from './thread-sandbox-store.js';

export type ProvisionError =
  /** The thread was deleted while its sandbox was being prepared. */
  | { kind: 'cancelled'; message: string }
  /** The sandbox's state changed underneath the operation (e.g. it was deleted). */
  | { kind: 'conflict'; message: string }
  | { kind: 'already-provisioned'; message: string }
  | { kind: 'connection'; message: string }
  | { kind: 'invalid-size'; message: string }
  | { kind: 'token'; message: string }
  | { kind: 'checkout'; message: string }
  | { kind: 'sandbox'; message: string; cause: SandboxError['kind'] }
  | { kind: 'storage'; message: string };

export interface ThreadSandboxDeps extends ThreadSandboxControlDeps {
  templates: RunnerTemplateManager;
  build: RunnerBuild;
  /** Public origin the sandbox runner connects to. */
  serverUrl: string;
  issueToken(input: {
    userId: string;
    threadId: string;
  }): ResultAsync<{ token: string }, ProvisionTokenError>;
  /** Clone the project on the thread's sandbox runner (via runner-access). */
  requestCheckout?(input: {
    userId: string;
    threadId: string;
    path: string;
    repoUrl: string;
  }): ResultAsync<void, string>;
  readyTimeoutMs?: number;
}

export interface ProvisionInput {
  userId: string;
  threadId: string;
  connectionId: string;
  sizeId?: string;
  /** The project to materialize at its canonical path once the runner is up. */
  checkout?: { path: string; repoUrl: string };
  /** Aborting it (the thread was deleted) interrupts the preparation. */
  signal?: AbortSignal;
}

/** Absolute path made only of characters that need no shell quoting beyond '…'. */
const SAFE_PATH = /^\/[A-Za-z0-9._/@+-]+$/;

export function createThreadSandboxService(deps: ThreadSandboxDeps) {
  const control = createThreadSandboxControl(deps);
  const ops = sandboxOps(deps);
  const pollMs = deps.pollMs ?? 2_000;

  /** Best effort: if it fails, the provider lifetime cap still bounds the old machine. */
  const releaseMachine = (row: ThreadSandboxRow) =>
    Effect.ignore(fromResult(() => control.release(row.threadId)));

  const exec = (provider: SandboxProvider, handle: SandboxHandle, command: string, what: string) =>
    Effect.flatMap(
      providerCall(() => provider.exec(handle, command, { timeoutMs: 600_000 })),
      (result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail<ProvisionError>({
              kind: 'sandbox',
              message: `${what} failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`,
              cause: 'provider',
            }),
    );

  /** Poll the provider until the machine is running. */
  const waitRunning = (provider: SandboxProvider, handle: SandboxHandle) =>
    fromResult((signal) =>
      pollUntil(
        () =>
          provider.status(handle).andThen((s) => {
            if (s.state === 'running') return okAsync<true | null, SandboxError>(true);
            if (s.state === 'failed' || s.state === 'lost') {
              return errAsync<true | null, SandboxError>({
                kind: 'provider',
                message: `sandbox ${s.state}: ${s.detail ?? s.providerState}`,
              });
            }
            return okAsync<true | null, SandboxError>(null);
          }),
        {
          what: 'sandbox start',
          timeoutMs: deps.readyTimeoutMs ?? 5 * 60_000,
          intervalMs: pollMs,
          signal,
          sleep: deps.sleep,
        },
      ).mapErr(sandboxError),
    );

  /** Poll until the thread's sandbox runner has enrolled and is connected. */
  const waitConnected = (threadId: string) =>
    fromResult((signal) =>
      pollUntil(
        () =>
          ResultAsync.fromSafePromise(deps.sandboxRunnerIdForThread(threadId)).map((runnerId) =>
            runnerId && deps.presence?.isAvailable(runnerId) ? runnerId : null,
          ),
        {
          what: 'sandbox runner connection',
          timeoutMs: deps.connectTimeoutMs ?? 3 * 60_000,
          intervalMs: pollMs,
          signal,
          sleep: deps.sleep,
        },
      ).mapErr(sandboxError),
    );

  /**
   * Prepare the project's parent directory (no secrets, via the provider) and
   * let the sandbox runner clone it with the owner's per-operation credential.
   */
  const checkoutProject = (
    input: ProvisionInput,
    provider: SandboxProvider,
    handle: SandboxHandle,
  ) =>
    Effect.gen(function* () {
      const checkout = input.checkout;
      if (!checkout) return;
      const requestCheckout = deps.requestCheckout;
      if (!requestCheckout) {
        return yield* Effect.fail<ProvisionError>({
          kind: 'checkout',
          message: 'repository checkout is not wired',
        });
      }
      if (!SAFE_PATH.test(checkout.path) || checkout.path.includes('..')) {
        return yield* Effect.fail<ProvisionError>({
          kind: 'checkout',
          message: `unsupported project path ${checkout.path}`,
        });
      }
      const parent = checkout.path.replace(/\/[^/]+\/?$/, '') || '/';
      yield* ops.transition(input.threadId, 'BOOTSTRAP');
      yield* exec(
        provider,
        handle,
        `sudo mkdir -p '${parent}' && sudo chown "$(id -un)" '${parent}'`,
        'project directory setup',
      );
      yield* fromResult(() =>
        requestCheckout({
          userId: input.userId,
          threadId: input.threadId,
          path: checkout.path,
          repoUrl: checkout.repoUrl,
        }).mapErr((message): ProvisionError => ({ kind: 'checkout', message })),
      );
    });

  /**
   * The machine as a scoped resource: created on acquire and destroyed on
   * release unless the scope succeeded — so any failure *or* interruption
   * (thread deleted mid-setup) after the machine exists tears it down.
   */
  const acquireMachine = (
    input: ProvisionInput,
    row: ThreadSandboxRow,
    provider: SandboxProvider,
    template: TemplateRef | null,
  ) =>
    Effect.acquireRelease(
      // Safe to retry: the idempotency key returns the machine an earlier attempt made.
      ops.call(() =>
        provider.create({
          threadId: input.threadId,
          sizeId: row.sizeId,
          ...(template ? { template } : {}),
          env: {},
          lifetimeMs: deps.lifetimeMs ?? DEFAULT_SANDBOX_LIFETIME_MS,
          idempotencyKey: `${input.threadId}:${row.generation}`,
        }),
      ),
      (handle, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.ignore(
              Effect.andThen(
                ops.call(() => provider.destroy(handle)),
                // Gone: the reconciler has nothing left to release.
                ops.update(input.threadId, { sandboxId: null }),
              ),
            ),
    );

  /** Bring the sandbox up: machine, runner, connection, checkout. Yields the runner id. */
  const bringUp = (
    input: ProvisionInput,
    row: ThreadSandboxRow,
    provider: SandboxProvider,
    template: TemplateRef | null,
    provisionToken: string,
    llmToken: string,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const start = startRunnerCommand({
          TEAM_SERVER_URL: deps.serverUrl,
          RUNNER_PROVISION_TOKEN: provisionToken,
          // Model calls go through the server's LLM proxy with this token (llm-proxy).
          FUNNY_LLM_PROXY_TOKEN: llmToken,
        });
        if (start.isErr()) {
          return yield* Effect.fail<ProvisionError>({ kind: 'connection', message: start.error });
        }

        const handle = yield* acquireMachine(input, row, provider, template);
        yield* ops.update(input.threadId, { sandboxId: handle.sandboxId });
        yield* waitRunning(provider, handle);

        // No template: install the runner on the fly.
        if (!template) {
          yield* ops.transition(input.threadId, 'INSTALL');
          yield* exec(provider, handle, runnerInstallCommand(deps.build), 'runner install');
        }
        yield* exec(provider, handle, start.value, 'runner start');
        // The connect timeout starts here, once the runner is started.
        yield* ops.transition(input.threadId, 'CONNECT');
        const runnerId = yield* waitConnected(input.threadId);

        yield* checkoutProject(input, provider, handle);
        yield* ops.transition(input.threadId, 'READY', { runnerId, error: null });
        return runnerId;
      }),
    );

  const provision = (input: ProvisionInput) =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      const existing = yield* ops.get(input.threadId);
      if (existing && ACTIVE_SANDBOX_STATES.has(existing.state as ThreadSandboxState)) {
        return yield* Effect.fail<ProvisionError>({
          kind: 'already-provisioned',
          message: `thread already has a ${existing.state} sandbox`,
        });
      }
      // The new row replaces the old one: release a machine it still holds first
      // (a failed setup whose cleanup did not finish), or nothing would track it.
      if (existing?.sandboxId && existing.state !== 'lost') {
        yield* releaseMachine(existing);
      }
      const generation = (existing?.generation ?? -1) + 1;
      const { provider } = yield* fromResult(() =>
        providerForConnection(deps.connections, input.userId, input.connectionId),
      );
      const size = resolveSandboxSize(provider.capabilities(), input.sizeId);
      if (!size) {
        return yield* Effect.fail<ProvisionError>({
          kind: 'invalid-size',
          message: `${provider.id} has no size ${input.sizeId}`,
        });
      }

      const now = new Date().toISOString();
      const llm = mintLlmProxyToken();
      const row: ThreadSandboxRow = {
        threadId: input.threadId,
        userId: input.userId,
        connectionId: input.connectionId,
        provider: provider.id,
        sandboxId: null,
        runnerId: null,
        sizeId: size.id,
        repoUrl: input.checkout?.repoUrl ?? null,
        llmTokenHash: llm.hash,
        state: 'provisioning',
        error: null,
        generation,
        createdAt: now,
        updatedAt: now,
      };
      yield* fromResult(() =>
        deps.store.put(row).mapErr((message): ProvisionError => ({ kind: 'storage', message })),
      );

      return yield* Effect.onExit(
        Effect.gen(function* () {
          const [template, { token }] = yield* Effect.all(
            [
              fromResult(() =>
                deps.templates
                  .current(provider)
                  .orElse(() => okAsync<TemplateRef | null, never>(null)),
              ),
              fromResult(() =>
                deps
                  .issueToken({ userId: input.userId, threadId: input.threadId })
                  .mapErr((e): ProvisionError => ({ kind: 'token', message: e.kind })),
              ),
            ],
            { concurrency: 'unbounded' },
          );
          // No template yet: install on the fly now, build it for the next thread.
          if (!template) void deps.templates.ensure(input.connectionId, provider);

          yield* bringUp(input, row, provider, template, token, llm.token);
          metric('thread_sandboxes.provision_ms', Date.now() - startedAt, {
            type: 'gauge',
            unit: 'ms',
            attributes: { provider: provider.id },
          });
          return (yield* ops.get(input.threadId)) ?? row;
        }),
        (exit) => {
          if (Exit.isSuccess(exit)) return Effect.void;
          const error = exitFailure(exit);
          log.warn('Thread sandbox provisioning failed', {
            namespace: 'thread-sandboxes',
            threadId: input.threadId,
            provider: provider.id,
            kind: error.kind,
            error: error.message,
          });
          return ops.settle(input.threadId, 'FAIL', { error: error.message });
        },
      );
    });

  return {
    provision(input: ProvisionInput): ResultAsync<ThreadSandboxRow, ProvisionError> {
      return runToResult(provision(input), {
        signal: input.signal,
        onInterrupt: () => ({ kind: 'cancelled', message: 'sandbox preparation cancelled' }),
      });
    },
    ...control,
  };
}
