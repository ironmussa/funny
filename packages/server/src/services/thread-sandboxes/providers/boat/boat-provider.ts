/**
 * Boat.dev sandbox provider (change thread-sandboxes).
 *
 * Thin adapter over Boat's public REST API (https://boat.dev/api/v1, Bearer
 * `boat_…` key). It maps Boat states and errors onto the provider-neutral
 * contract; nothing outside `providers/` knows Boat exists. Uses `fetch`
 * directly (injectable for tests) instead of the SDK to keep the server free of
 * a provider-specific dependency.
 */

import { errAsync, okAsync } from 'neverthrow';
import { z } from 'zod';

import {
  type CreateSandboxRequest,
  type NormalizedSandboxState,
  type SandboxCapabilities,
  type SandboxError,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxStatus,
  type TemplateRef,
} from '../../contract.js';
import type { SandboxProviderEntry } from '../../registry.js';
import {
  createJsonApi,
  credentialErrorRule,
  createPoller,
  execResultFrom,
  execTimeoutSeconds,
  ignoreNotFound,
  mapByRules,
  installRunner,
  transientErrorRules,
  withThrowawayMachine,
  type ErrorRule,
  type Fetch,
} from '../shared/json-api.js';

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

interface BoatErrorContext {
  status: number;
  code: string;
  message: string;
  retryAfterMs: () => number | undefined;
}

/**
 * Ordered Boat error rules: the first match wins, anything else is a generic
 * `provider` error.
 */
const BOAT_ERROR_RULES: ErrorRule<BoatErrorContext>[] = [
  // An account feature the plan does not include (e.g. saved snapshots on the
  // free trial) is not a bad credential.
  {
    when: (e) => e.status === 403 && e.code.endsWith('_not_allowed'),
    map: (e) => ({ kind: 'unsupported', message: e.message }),
  },
  credentialErrorRule<BoatErrorContext>(),
  {
    when: (e) => e.status === 402 || e.code === 'billing_required',
    map: (e) => ({
      kind: 'quota',
      message: `${e.message} (start the Boat plan to create sandboxes)`,
    }),
  },
  { when: (e) => e.status === 404, map: (e) => ({ kind: 'not-found', message: e.message }) },
  {
    when: (e) => e.code === 'snapshot_data_expired',
    map: (e) => ({ kind: 'expired', message: e.message }),
  },
  {
    when: (e) => e.code === 'sandbox_starting' || e.code === 'machine_not_running',
    map: (e) => ({ kind: 'unavailable', message: e.message, retryAfterMs: 3_000 }),
  },
  ...transientErrorRules<BoatErrorContext>((e) => e.code === 'rate_limited'),
];

/** Boat error envelope → normalized `SandboxError`. */
/** A Boat error field, top-level or nested under `error`. */
function boatErrorField(body: any, key: 'code' | 'message'): string | undefined {
  return body?.[key] ?? body?.error?.[key];
}

function boatErrorContext(res: Response, body: any): BoatErrorContext {
  return {
    status: res.status,
    code: boatErrorField(body, 'code') ?? '',
    message: boatErrorField(body, 'message') ?? `Boat API ${res.status}`,
    retryAfterMs: () => retryAfterMs(body, res),
  };
}

function mapBoatError(res: Response, body: any): SandboxError {
  return mapByRules(BOAT_ERROR_RULES, boatErrorContext(res, body));
}

export interface BoatProviderOptions {
  fetch?: Fetch;
  /** Injected wait for deterministic tests. */
  sleep?: (ms: number) => PromiseLike<void>;
  /** Polling cadence and limits of the template build (overridable in tests). */
  pollMs?: number;
  readyTimeoutMs?: number;
  snapshotTimeoutMs?: number;
  /** Per-request cap, so a hung Boat call cannot block an operation forever. */
  requestTimeoutMs?: number;
}

export function createBoatProvider(
  apiKey: string,
  config: BoatConfig = {},
  options: BoatProviderOptions = {},
): SandboxProvider {
  const { call, requestTimeoutMs } = createJsonApi({
    label: 'Boat',
    baseUrl: config.apiBaseUrl ?? DEFAULT_BASE_URL,
    authHeaders: { Authorization: `Bearer ${apiKey}` },
    fetch: options.fetch,
    requestTimeoutMs: options.requestTimeoutMs,
    mapError: mapBoatError,
  });
  const poll = createPoller(options.pollMs ?? 3_000, options.sleep);

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
      ignoreNotFound(
        call('DELETE', `/sandboxes/${handle.sandboxId}`, {
          headers: { 'X-Ascii-Confirm-Delete': handle.sandboxId },
        }),
      ),

    exec: (handle, command, opts) => {
      const timeoutSeconds = execTimeoutSeconds(opts?.timeoutMs, 600);
      // The request waits for the command: its cap is the command's plus slack.
      return call('POST', `/sandboxes/${handle.sandboxId}/commands`, {
        body: { command, timeoutSeconds },
        timeoutMs: timeoutSeconds * 1000 + requestTimeoutMs,
      }).map(execResultFrom);
    },

    listTemplates: () =>
      call('GET', '/saved-snapshots').map((body): TemplateRef[] => {
        const items: any[] = body?.savedSnapshots ?? body?.snapshots ?? body?.items ?? [];
        return items
          .map((item) => String(item?.name ?? ''))
          .filter((name) => name.startsWith(TEMPLATE_PREFIX))
          .map((name) => ({ providerId: BOAT_PROVIDER_ID, ref: name }));
      }),

    deleteTemplate: (template) =>
      ignoreNotFound(call('DELETE', `/saved-snapshots/${encodeURIComponent(template.ref)}`)),

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
        const steps = installRunner(provider, handle, req, {
          poll,
          readyTimeoutMs: options.readyTimeoutMs,
          execTimeoutMs: 600_000,
        })
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
        return withThrowawayMachine(handle, steps, provider.destroy);
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
