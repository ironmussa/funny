/**
 * Boat.dev sandbox provider (change thread-sandboxes).
 *
 * Thin adapter over Boat's public REST API (https://boat.dev/api/v1, Bearer
 * `boat_…` key). It maps Boat states and errors onto the provider-neutral
 * contract; nothing outside `providers/` knows Boat exists. Uses `fetch`
 * directly (injectable for tests) instead of the SDK to keep the server free of
 * a provider-specific dependency.
 */

import { retryAsync } from '@funny/shared/async';
import { errAsync, okAsync, ResultAsync, type Result } from 'neverthrow';
import { z } from 'zod';

import {
  isRetryableSandboxError,
  type CreateSandboxRequest,
  type ExecResult,
  type NormalizedSandboxState,
  type SandboxCapabilities,
  type SandboxError,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxStatus,
  type TemplateRef,
} from '../../contract.js';
import type { SandboxProviderEntry } from '../../registry.js';
import { scriptCommand } from '../../runner-install-script.js';

const BOAT_PROVIDER_ID = 'boat';
const TEMPLATE_PREFIX = 'funny-runner-';
const DEFAULT_BASE_URL = 'https://boat.dev/api/v1';
const DAY_MS = 24 * 60 * 60 * 1000;

const boatCapabilities: SandboxCapabilities = {
  stopPreservesDisk: true,
  stoppedRetentionMs: 14 * DAY_MS,
  maxLifetimeMs: 30 * DAY_MS,
  sizes: [
    { id: 'small', vcpu: 2, memoryGb: 4 },
    { id: 'default', vcpu: 4, memoryGb: 8, default: true },
    { id: 'large', vcpu: 8, memoryGb: 16 },
    { id: 'xlarge', vcpu: 16, memoryGb: 32 },
  ],
  env: { maxVars: 100, maxBytes: 64 * 1024 },
  preStopHook: 'native',
};

/** Boat API states → normalized states. */
const STATE_MAP: Record<string, NormalizedSandboxState> = {
  provisioning: 'provisioning',
  provisioned: 'provisioning',
  cloning: 'provisioning',
  ready: 'running',
  idle: 'running',
  running: 'running',
  archiving: 'stopping',
  archived: 'stopped',
  error: 'failed',
};

const boatConfigSchema = z
  .object({
    /** Override for tests or a self-hosted Boat API. */
    apiBaseUrl: z.string().url().optional(),
  })
  .strict();

type BoatConfig = z.infer<typeof boatConfigSchema>;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Saved-snapshot name of the funny runner template for a server version. */
export function boatTemplateName(serverVersion: string): string {
  return `${TEMPLATE_PREFIX}${serverVersion.replace(/[^A-Za-z0-9.-]/g, '-')}`;
}

function retryAfterMs(body: any, res: Response): number | undefined {
  const seconds =
    body?.error?.details?.retryAfterSeconds ??
    body?.retryAfterSeconds ??
    Number(res.headers.get('retry-after') ?? NaN);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** Boat error envelope → normalized `SandboxError`. */
export function mapBoatError(res: Response, body: any): SandboxError {
  const code: string = body?.code ?? body?.error?.code ?? '';
  const message: string = body?.message ?? body?.error?.message ?? `Boat API ${res.status}`;
  // An account feature the plan does not include (e.g. saved snapshots on the
  // free trial) is not a bad credential.
  if (res.status === 403 && code.endsWith('_not_allowed')) return { kind: 'unsupported', message };
  if (res.status === 401 || res.status === 403) return { kind: 'auth', message };
  if (res.status === 402 || code === 'billing_required') {
    return { kind: 'quota', message: `${message} (start the Boat plan to create sandboxes)` };
  }
  if (res.status === 404) return { kind: 'not-found', message };
  if (code === 'snapshot_data_expired') return { kind: 'expired', message };
  if (code === 'sandbox_starting' || code === 'machine_not_running') {
    return { kind: 'unavailable', message, retryAfterMs: 3_000 };
  }
  if (res.status === 429 && code === 'rate_limited') {
    return { kind: 'rate-limited', message, retryAfterMs: retryAfterMs(body, res) };
  }
  if (res.status === 429) return { kind: 'quota', message };
  if (res.status >= 500) {
    return { kind: 'unavailable', message, retryAfterMs: retryAfterMs(body, res) };
  }
  return { kind: 'provider', message: code ? `${code}: ${message}` : message };
}

export interface BoatProviderOptions {
  fetch?: Fetch;
  /** Injected wait for deterministic tests. */
  sleep?: (ms: number) => PromiseLike<void>;
  /** Polling cadence and limits of the template build (overridable in tests). */
  pollMs?: number;
  readyTimeoutMs?: number;
  snapshotTimeoutMs?: number;
}

const NOT_READY = Symbol('not-ready');

const isSandboxError = (value: unknown): value is SandboxError =>
  typeof value === 'object' && value !== null && 'kind' in value && 'message' in value;

export function createBoatProvider(
  apiKey: string,
  config: BoatConfig = {},
  options: BoatProviderOptions = {},
): SandboxProvider {
  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const pollMs = options.pollMs ?? 3_000;
  const baseUrl = (config.apiBaseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  function call(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): ResultAsync<any, SandboxError> {
    const request = fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    return ResultAsync.fromPromise(request, (error): SandboxError => ({
      kind: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    })).andThen((res) =>
      ResultAsync.fromSafePromise(res.json().catch(() => ({}))).andThen((body) =>
        res.ok ? okAsync(body) : errAsync(mapBoatError(res, body)),
      ),
    );
  }

  /** Poll `check` until it yields a value; retries Boat's transient errors. */
  function poll<T>(
    what: string,
    timeoutMs: number,
    check: () => ResultAsync<T | null, SandboxError>,
    signal?: AbortSignal,
  ): ResultAsync<T, SandboxError> {
    const attempt = async () => {
      const result = await check();
      if (result.isErr()) throw result.error;
      if (result.value === null) throw NOT_READY;
      return result.value;
    };
    return ResultAsync.fromPromise(
      retryAsync(attempt, {
        delayMs: () => pollMs,
        while: (error) =>
          error === NOT_READY || (isSandboxError(error) && isRetryableSandboxError(error)),
        timeoutMs,
        timeoutError: () => ({ kind: 'unavailable', message: `${what} timed out` }),
        sleep: options.sleep,
        signal,
      }),
      (error): SandboxError =>
        isSandboxError(error)
          ? error
          : { kind: 'unavailable', message: `${what} failed: ${String(error)}` },
    );
  }

  const savedSnapshotStatus = (body: any): string | undefined =>
    body?.snapshot?.status ?? body?.savedSnapshot?.status;

  const ttlSeconds = (ms: number | undefined) =>
    ms === undefined ? undefined : Math.max(60, Math.round(ms / 1000));

  const provider: SandboxProvider = {
    id: BOAT_PROVIDER_ID,
    capabilities: () => boatCapabilities,

    validate: () =>
      call('GET', '/limits').andThen((body) =>
        body?.blockedReason
          ? errAsync<never, SandboxError>({
              kind: 'quota',
              message: `Boat account blocked: ${body.blockedReason}`,
            })
          : okAsync({ accountLabel: `boat (${body?.accessTier ?? 'account'})` }),
      ),

    resolveTemplate: (serverVersion) => {
      const name = boatTemplateName(serverVersion);
      return call('GET', `/saved-snapshots/${encodeURIComponent(name)}`)
        .andThen((body) => {
          const status = savedSnapshotStatus(body);
          if (status === 'saving') {
            return errAsync<TemplateRef, SandboxError>({
              kind: 'unavailable',
              message: `Boat saved snapshot ${name} is still saving`,
              retryAfterMs: 15_000,
            });
          }
          if (status === 'failed') {
            return errAsync<TemplateRef, SandboxError>({ kind: 'not-found', message: name });
          }
          return okAsync<TemplateRef, SandboxError>({ providerId: BOAT_PROVIDER_ID, ref: name });
        })
        .orElse((error) =>
          errAsync<TemplateRef, SandboxError>(
            error.kind === 'not-found'
              ? { kind: 'template-missing', message: `Boat saved snapshot ${name} not found` }
              : error,
          ),
        );
    },

    create: (req: CreateSandboxRequest) =>
      call('POST', '/sandboxes', {
        headers: { 'Idempotency-Key': req.idempotencyKey },
        body: {
          type: req.sizeId,
          ...(req.template ? { from: req.template.ref } : {}),
          env: req.env,
          name: `funny-${req.threadId}`,
          ttlSeconds: ttlSeconds(req.lifetimeMs) ?? null,
        },
      }).andThen((body) => {
        const sandboxId = body?.sandbox?.id;
        return typeof sandboxId === 'string'
          ? okAsync<SandboxHandle, SandboxError>({ providerId: BOAT_PROVIDER_ID, sandboxId })
          : errAsync<SandboxHandle, SandboxError>({
              kind: 'provider',
              message: 'Boat create returned no sandbox id',
            });
      }),

    status: (handle) =>
      call('GET', `/sandboxes/${handle.sandboxId}`).map((body): SandboxStatus => {
        const providerState: string = body?.sandbox?.state ?? 'unknown';
        const expired = !!body?.sandbox?.dataExpiredAt;
        return {
          state: expired ? 'lost' : (STATE_MAP[providerState] ?? 'failed'),
          providerState,
          detail: body?.sandbox?.error ?? undefined,
        };
      }),

    stop: (handle) => call('POST', `/sandboxes/${handle.sandboxId}/stop`).map(() => undefined),

    resume: (handle, opts) =>
      call('POST', `/sandboxes/${handle.sandboxId}/resume`, {
        body: { ttlSeconds: ttlSeconds(opts?.lifetimeMs) ?? null },
      }).map(() => undefined),

    extendLifetime: (handle, lifetimeMs) =>
      call('PATCH', `/sandboxes/${handle.sandboxId}`, {
        body: {
          ttlSeconds: ttlSeconds(Math.min(lifetimeMs, boatCapabilities.maxLifetimeMs!)),
        },
      }).map(() => undefined),

    destroy: (handle) =>
      call('DELETE', `/sandboxes/${handle.sandboxId}`, {
        headers: { 'X-Ascii-Confirm-Delete': handle.sandboxId },
      })
        .map(() => undefined)
        .orElse((error) => (error.kind === 'not-found' ? okAsync(undefined) : errAsync(error))),

    exec: (handle, command, opts) =>
      call('POST', `/sandboxes/${handle.sandboxId}/commands`, {
        body: {
          command,
          timeoutSeconds: Math.min(
            600,
            Math.max(1, Math.ceil((opts?.timeoutMs ?? 300_000) / 1000)),
          ),
        },
      }).map((body): ExecResult => ({
        exitCode: typeof body?.exitCode === 'number' ? body.exitCode : -1,
        stdout: String(body?.stdout ?? ''),
        stderr: String(body?.stderr ?? ''),
      })),

    listTemplates: () =>
      call('GET', '/saved-snapshots').map((body): TemplateRef[] => {
        const items: any[] = body?.savedSnapshots ?? body?.snapshots ?? body?.items ?? [];
        return items
          .map((item) => String(item?.name ?? ''))
          .filter((name) => name.startsWith(TEMPLATE_PREFIX))
          .map((name) => ({ providerId: BOAT_PROVIDER_ID, ref: name }));
      }),

    deleteTemplate: (template) =>
      call('DELETE', `/saved-snapshots/${encodeURIComponent(template.ref)}`)
        .map(() => undefined)
        .orElse((error) => (error.kind === 'not-found' ? okAsync(undefined) : errAsync(error))),

    /**
     * Throwaway `small` sandbox → install script → saved snapshot → poll until
     * ready. The throwaway sandbox is deleted whether the build succeeds or not.
     */
    buildTemplate: (req) => {
      const name = boatTemplateName(req.serverVersion);
      const created = call('POST', '/sandboxes', {
        headers: { 'Idempotency-Key': `funny-template:${name}:${Date.now()}` },
        body: { type: 'small', ttlSeconds: 3600, name: `funny-template-${req.serverVersion}` },
      }).andThen((body) =>
        typeof body?.sandbox?.id === 'string'
          ? okAsync<SandboxHandle, SandboxError>({
              providerId: BOAT_PROVIDER_ID,
              sandboxId: body.sandbox.id,
            })
          : errAsync<SandboxHandle, SandboxError>({
              kind: 'provider',
              message: 'Boat create returned no sandbox id',
            }),
      );
      return created.andThen((handle) => {
        const steps = poll(
          'template sandbox start',
          options.readyTimeoutMs ?? 5 * 60_000,
          () => provider.status(handle).map((s) => (s.state === 'running' ? true : null)),
          req.signal,
        )
          .andThen(() =>
            provider.exec(handle, scriptCommand(req.installScript, req.scriptEnv), {
              timeoutMs: 600_000,
            }),
          )
          .andThen((result) =>
            result.exitCode === 0
              ? okAsync<void, SandboxError>(undefined)
              : errAsync<void, SandboxError>({
                  kind: 'provider',
                  message: `runner install failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`,
                }),
          )
          .andThen(() =>
            call('POST', '/saved-snapshots', { body: { sandboxId: handle.sandboxId, name } }),
          )
          .andThen(() =>
            poll(
              'template snapshot save',
              options.snapshotTimeoutMs ?? 15 * 60_000,
              () =>
                call('GET', `/saved-snapshots/${encodeURIComponent(name)}`).andThen((body) => {
                  const status = savedSnapshotStatus(body);
                  if (status === 'failed') {
                    return errAsync<true | null, SandboxError>({
                      kind: 'provider',
                      message: `Boat failed to save ${name}`,
                    });
                  }
                  return okAsync<true | null, SandboxError>(status === 'saving' ? null : true);
                }),
              req.signal,
            ),
          )
          .map((): TemplateRef => ({ providerId: BOAT_PROVIDER_ID, ref: name }));
        // Always delete the throwaway sandbox, then surface the build outcome.
        const finish = async (): Promise<Result<TemplateRef, SandboxError>> => {
          const outcome = await steps;
          await provider.destroy(handle);
          return outcome;
        };
        return new ResultAsync(finish());
      });
    },
  };
  return provider;
}

/** Production registry entry (registered in `provider-catalog.ts`). */
export const boatProviderEntry: SandboxProviderEntry<BoatConfig> = {
  id: BOAT_PROVIDER_ID,
  displayName: 'Boat',
  configSchema: boatConfigSchema,
  capabilities: boatCapabilities,
  create: ({ credential, config }) => createBoatProvider(credential, config),
};
