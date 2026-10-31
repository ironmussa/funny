/**
 * Boat.dev sandbox provider (change thread-sandboxes).
 *
 * Thin adapter over Boat's public REST API (https://boat.dev/api/v1, Bearer
 * `boat_…` key). It maps Boat states and errors onto the provider-neutral
 * contract; nothing outside `providers/` knows Boat exists. Uses `fetch`
 * directly (injectable for tests) instead of the SDK to keep the server free of
 * a provider-specific dependency.
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';

import type {
  CreateSandboxRequest,
  NormalizedSandboxState,
  SandboxCapabilities,
  SandboxError,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
  TemplateRef,
} from '../../contract.js';
import type { SandboxProviderEntry } from '../../registry.js';

const BOAT_PROVIDER_ID = 'boat';
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
  return `funny-runner-${serverVersion.replace(/[^A-Za-z0-9.-]/g, '-')}`;
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
  if (res.status === 401 || res.status === 403) return { kind: 'auth', message };
  if (res.status === 402 || code === 'billing_required') {
    return { kind: 'quota', message: `${message} (start the Boat plan to create sandboxes)` };
  }
  if (res.status === 404) return { kind: 'not-found', message };
  if (code === 'snapshot_data_expired') return { kind: 'expired', message };
  if (res.status === 429 && code === 'rate_limited') {
    return { kind: 'rate-limited', message, retryAfterMs: retryAfterMs(body, res) };
  }
  if (res.status === 429) return { kind: 'quota', message };
  if (res.status >= 500) {
    return { kind: 'unavailable', message, retryAfterMs: retryAfterMs(body, res) };
  }
  return { kind: 'provider', message: code ? `${code}: ${message}` : message };
}

export function createBoatProvider(
  apiKey: string,
  config: BoatConfig = {},
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): SandboxProvider {
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

  const ttlSeconds = (ms: number | undefined) =>
    ms === undefined ? undefined : Math.max(60, Math.round(ms / 1000));

  return {
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
        .map((): TemplateRef => ({ providerId: BOAT_PROVIDER_ID, ref: name }))
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
          from: req.template.ref,
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
  };
}

/** Production registry entry (registered in `provider-catalog.ts`). */
export const boatProviderEntry: SandboxProviderEntry<BoatConfig> = {
  id: BOAT_PROVIDER_ID,
  displayName: 'Boat',
  configSchema: boatConfigSchema,
  capabilities: boatCapabilities,
  create: ({ credential, config }) => createBoatProvider(credential, config),
};
