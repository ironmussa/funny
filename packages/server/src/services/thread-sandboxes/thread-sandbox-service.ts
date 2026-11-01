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
 *   provisioning → (installing) → connecting → running        (or failed)
 *
 * A ready runner template is used when there is one; otherwise the sandbox
 * starts from the provider's base image and the runner is installed on the fly
 * while the template is built in the background for the next thread. The runner
 * enrolls itself with a single-use provisioning token and becomes the `sandbox`
 * runner of the thread. Any failure after the machine exists destroys it.
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import type { ProvisionTokenError } from '../runner-provision-tokens.js';
import {
  resolveSandboxSize,
  type SandboxError,
  type SandboxHandle,
  type SandboxProvider,
  type TemplateRef,
} from './contract.js';
import type { InfraConnectionError } from './infra-connections.js';
import { pollUntil } from './poll.js';
import type { RunnerBuild } from './runner-build.js';
import { runnerInstallCommand, startRunnerCommand } from './runner-install-script.js';
import type { RunnerTemplateManager } from './template-manager.js';
import {
  createThreadSandboxControl,
  sandboxError,
  type ThreadSandboxControlDeps,
} from './thread-sandbox-control.js';
import type { ThreadSandboxRow, ThreadSandboxState } from './thread-sandbox-store.js';

export type ProvisionError =
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
  signal?: AbortSignal;
}

/** Absolute path made only of characters that need no shell quoting beyond '…'. */
const SAFE_PATH = /^\/[A-Za-z0-9._/@+-]+$/;

const ACTIVE_STATES = new Set<ThreadSandboxState>([
  'bootstrapping',
  'provisioning',
  'installing',
  'connecting',
  'running',
]);

export function createThreadSandboxService(deps: ThreadSandboxDeps) {
  const control = createThreadSandboxControl(deps);
  const pollMs = deps.pollMs ?? 2_000;
  const fromStore = <T>(r: ResultAsync<T, string>) =>
    r.mapErr((message): ProvisionError => ({ kind: 'storage', message }));

  const setState = (
    threadId: string,
    state: ThreadSandboxState,
    patch: Partial<ThreadSandboxRow> = {},
  ) => fromStore(deps.store.update(threadId, { ...patch, state }));

  const exec = (provider: SandboxProvider, handle: SandboxHandle, command: string, what: string) =>
    provider
      .exec(handle, command, { timeoutMs: 600_000 })
      .mapErr(sandboxError)
      .andThen((result) =>
        result.exitCode === 0
          ? okAsync<void, ProvisionError>(undefined)
          : errAsync<void, ProvisionError>({
              kind: 'sandbox',
              message: `${what} failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`,
              cause: 'provider',
            }),
      );

  /** Runs once a machine exists; any failure destroys it and marks the thread failed. */
  function bringUpRunner(
    input: ProvisionInput,
    provider: SandboxProvider,
    handle: SandboxHandle,
    template: TemplateRef | null,
    token: string,
  ): ResultAsync<string, ProvisionError> {
    const waitRunning = pollUntil(
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
        signal: input.signal,
        sleep: deps.sleep,
      },
    ).mapErr(sandboxError);

    const install = template
      ? okAsync<void, ProvisionError>(undefined)
      : setState(input.threadId, 'installing').andThen(() =>
          exec(provider, handle, runnerInstallCommand(deps.build), 'runner install'),
        );

    const start = startRunnerCommand({
      TEAM_SERVER_URL: deps.serverUrl,
      RUNNER_PROVISION_TOKEN: token,
    });
    if (start.isErr()) return errAsync({ kind: 'connection', message: start.error });

    const waitConnected = pollUntil(
      () =>
        ResultAsync.fromSafePromise(deps.sandboxRunnerIdForThread(input.threadId)).map(
          (runnerId) => (runnerId && deps.presence?.isAvailable(runnerId) ? runnerId : null),
        ),
      {
        what: 'sandbox runner connection',
        timeoutMs: deps.connectTimeoutMs ?? 3 * 60_000,
        intervalMs: pollMs,
        signal: input.signal,
        sleep: deps.sleep,
      },
    ).mapErr(sandboxError);

    return waitRunning
      .andThen(() => install)
      .andThen(() => exec(provider, handle, start.value, 'runner start'))
      .andThen(() => setState(input.threadId, 'connecting'))
      .andThen(() => waitConnected)
      .andThrough(() => checkoutProject(input, provider, handle));
  }

  /**
   * Prepare the project's parent directory (no secrets, via the provider) and
   * let the sandbox runner clone it with the owner's per-operation credential.
   */
  function checkoutProject(
    input: ProvisionInput,
    provider: SandboxProvider,
    handle: SandboxHandle,
  ): ResultAsync<void, ProvisionError> {
    const checkout = input.checkout;
    if (!checkout) return okAsync(undefined);
    if (!deps.requestCheckout) {
      return errAsync({ kind: 'checkout', message: 'repository checkout is not wired' });
    }
    if (!SAFE_PATH.test(checkout.path) || checkout.path.includes('..')) {
      return errAsync({ kind: 'checkout', message: `unsupported project path ${checkout.path}` });
    }
    const parent = checkout.path.replace(/\/[^/]+\/?$/, '') || '/';
    const prepare = `sudo mkdir -p '${parent}' && sudo chown "$(id -un)" '${parent}'`;
    const requestCheckout = deps.requestCheckout;
    return setState(input.threadId, 'bootstrapping')
      .andThen(() => exec(provider, handle, prepare, 'project directory setup'))
      .andThen(() =>
        requestCheckout({
          userId: input.userId,
          threadId: input.threadId,
          path: checkout.path,
          repoUrl: checkout.repoUrl,
        }).mapErr((message): ProvisionError => ({ kind: 'checkout', message })),
      );
  }

  return {
    provision(input: ProvisionInput): ResultAsync<ThreadSandboxRow, ProvisionError> {
      const startedAt = Date.now();
      return fromStore(deps.store.get(input.threadId))
        .andThen((existing) =>
          existing && ACTIVE_STATES.has(existing.state as ThreadSandboxState)
            ? errAsync<number, ProvisionError>({
                kind: 'already-provisioned',
                message: `thread already has a ${existing.state} sandbox`,
              })
            : okAsync<number, ProvisionError>((existing?.generation ?? -1) + 1),
        )
        .andThen((generation) =>
          deps.connections
            .providerFor(input.userId, input.connectionId)
            .mapErr((e: InfraConnectionError): ProvisionError => ({
              kind: 'connection',
              message: e.message,
            }))
            .map(({ provider }) => ({ generation, provider })),
        )
        .andThen(({ generation, provider }) => {
          const size = resolveSandboxSize(provider.capabilities(), input.sizeId);
          if (!size) {
            return errAsync<never, ProvisionError>({
              kind: 'invalid-size',
              message: `${provider.id} has no size ${input.sizeId}`,
            });
          }
          const now = new Date().toISOString();
          const row: ThreadSandboxRow = {
            threadId: input.threadId,
            userId: input.userId,
            connectionId: input.connectionId,
            provider: provider.id,
            sandboxId: null,
            runnerId: null,
            sizeId: size.id,
            repoUrl: input.checkout?.repoUrl ?? null,
            state: 'provisioning',
            error: null,
            generation,
            createdAt: now,
            updatedAt: now,
          };
          return fromStore(deps.store.put(row)).map(() => ({ row, provider }));
        })
        .andThen(({ row, provider }) => {
          const template = deps.templates
            .current(provider)
            .orElse(() => okAsync<TemplateRef | null, never>(null))
            .map((ref) => {
              // No template yet: install on the fly now, build it for the next thread.
              if (!ref) void deps.templates.ensure(input.connectionId, provider);
              return ref;
            });
          const token = deps
            .issueToken({ userId: input.userId, threadId: input.threadId })
            .mapErr((e): ProvisionError => ({ kind: 'token', message: e.kind }));

          return ResultAsync.combine([template, token] as const)
            .andThen(([ref, { token: provisionToken }]) =>
              provider
                .create({
                  threadId: input.threadId,
                  sizeId: row.sizeId,
                  ...(ref ? { template: ref } : {}),
                  env: {},
                  lifetimeMs: deps.lifetimeMs ?? 4 * 60 * 60_000,
                  idempotencyKey: `${input.threadId}:${row.generation}`,
                })
                .mapErr(sandboxError)
                .andThen((handle) =>
                  setState(input.threadId, 'provisioning', { sandboxId: handle.sandboxId }).andThen(
                    () =>
                      bringUpRunner(input, provider, handle, ref, provisionToken).orElse((error) =>
                        // The machine exists: never leave it running (and billing) after a failure.
                        ResultAsync.fromSafePromise(
                          Promise.resolve(provider.destroy(handle)),
                        ).andThen(() => errAsync<string, ProvisionError>(error)),
                      ),
                  ),
                ),
            )
            .andThen((runnerId) =>
              setState(input.threadId, 'running', { runnerId, error: null }).map(() => runnerId),
            )
            .andTee(() =>
              metric('thread_sandboxes.provision_ms', Date.now() - startedAt, {
                type: 'gauge',
                unit: 'ms',
                attributes: { provider: provider.id },
              }),
            )
            .orElse((error) => {
              log.warn('Thread sandbox provisioning failed', {
                namespace: 'thread-sandboxes',
                threadId: input.threadId,
                provider: provider.id,
                kind: error.kind,
                error: error.message,
              });
              return setState(input.threadId, 'failed', { error: error.message }).andThen(() =>
                errAsync<string, ProvisionError>(error),
              );
            })
            .andThen(() => fromStore(deps.store.get(input.threadId)))
            .map((stored) => stored ?? row);
        });
    },
    ...control,
  };
}

export type ThreadSandboxService = ReturnType<typeof createThreadSandboxService>;
