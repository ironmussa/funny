/**
 * InstaBox sandbox provider (change thread-sandboxes).
 *
 * Thin adapter over InstaBox's public REST API (https://api.instabox.sh,
 * `X-API-Key: ibk_…`). Each sandbox is a Firecracker microVM ("machine") with
 * systemd, sudo, git and Bun on the default `agent-browser` template, so the
 * provider-neutral runner install script runs as is. Lifecycle calls are
 * asynchronous operations: the adapter fires them and the lifecycle polls
 * `status`, like every other provider. Uses `fetch` directly (injectable for
 * tests) to keep the server free of a provider-specific dependency.
 *
 * The API key needs the scopes `machines:read`, `machines:write`,
 * `machines:delete` and `images:read` to run threads, plus `images:write` and
 * `images:delete` to build and clean up the runner template.
 */

import { randomUUID } from 'node:crypto';

import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';

import type {
  CreateSandboxRequest,
  NormalizedSandboxState,
  SandboxCapabilities,
  SandboxError,
  SandboxHandle,
  SandboxIngress,
  SandboxProvider,
  SandboxStatus,
  TemplateBuildRequest,
  TemplateRef,
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

const INSTABOX_PROVIDER_ID = 'instabox';
const TEMPLATE_PREFIX = 'funny-runner-';
const DEFAULT_BASE_URL = 'https://api.instabox.sh';
/** InstaBox bounds for `archiveSeconds` / `deleteAfterSeconds`. */
const MIN_DEADLINE_SECONDS = 60;
const MAX_DEADLINE_SECONDS = 86_400;
/** `exec` waits at most this long server-side. */
const MAX_EXEC_SECONDS = 600;

/**
 * A stopped or paused machine is kept until deleted (no retention purge). There
 * is no lifetime cap that can be extended or set again on start, so
 * `maxLifetimeMs` is null; a create still honors `lifetimeMs` once, as a
 * one-shot `archiveSeconds` stop (see `create`).
 */
const instaboxCapabilities: SandboxCapabilities = {
  stopPreservesDisk: true,
  stoppedRetentionMs: null,
  maxLifetimeMs: null,
  // Sizes beyond the default depend on the plan (Free: default only); a size the
  // plan lacks is refused with `spec_not_allowed` (kind `unsupported`).
  sizes: [
    { id: 'small', vcpu: 2, memoryGb: 4 },
    { id: 'default', vcpu: 4, memoryGb: 8, default: true },
    { id: 'large', vcpu: 8, memoryGb: 16 },
    { id: 'xlarge', vcpu: 16, memoryGb: 32 },
  ],
  env: { maxVars: 128, maxBytes: 32 * 1024 },
  // `stop` is a clean systemd shutdown, so units get their stop hooks.
  preStopHook: 'native',
};

/** InstaBox machine states → normalized states (`running` also needs `runtime.ready`). */
const STATE_MAP: Record<string, NormalizedSandboxState> = {
  creating: 'provisioning',
  starting: 'provisioning',
  resuming: 'provisioning',
  running: 'running',
  stopping: 'stopping',
  suspending: 'stopping',
  deleting: 'stopping',
  stopped: 'stopped',
  // Paused (memory kept): `start` brings it back like a stopped machine.
  suspended: 'stopped',
  deleted: 'lost',
  error: 'failed',
};

const instaboxConfigSchema = z
  .object({
    /** Override for tests or a self-hosted InstaBox API. */
    apiBaseUrl: z.string().url().optional(),
    /**
     * Idle pause in seconds. Absent: the plan's default (30 minutes). Paid
     * plans take 300-1800, or 0 (off) where the plan allows always-on.
     */
    autoSuspendAfterSeconds: z.number().int().min(0).optional(),
  })
  .strict();

type InstaboxConfig = z.infer<typeof instaboxConfigSchema>;

/** Snapshot name of the funny runner template for a server version. */
export function instaboxTemplateName(serverVersion: string): string {
  const version = serverVersion.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `${TEMPLATE_PREFIX}${version}`.slice(0, 63);
}

/** `ms` as whole seconds within InstaBox's deadline bounds. */
function deadlineSeconds(ms: number): number {
  return Math.min(MAX_DEADLINE_SECONDS, Math.max(MIN_DEADLINE_SECONDS, Math.round(ms / 1000)));
}

interface InstaboxErrorContext {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  requiredScopes: string[];
  retryAfterMs: () => number | undefined;
}

function retryAfterMs(error: any, res: Response): number | undefined {
  const seconds = error.retryAfterSeconds ?? Number(res.headers.get('retry-after') ?? NaN);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** InstaBox error envelope: `{ error: { code, message, hint?, retryable, … } }`. */
function errorContext(res: Response, body: any): InstaboxErrorContext {
  const error = body?.error ?? {};
  const message = error.message ?? `InstaBox API ${res.status}`;
  return {
    status: res.status,
    code: String(error.code ?? ''),
    message: error.hint ? `${message} — ${error.hint}` : message,
    retryable: error.retryable === true,
    requiredScopes: Array.isArray(error.requiredScopes) ? error.requiredScopes : [],
    retryAfterMs: () => retryAfterMs(error, res),
  };
}

const NOT_ALLOWED_BY_PLAN = new Set(['spec_not_allowed', 'template_not_allowed', 'template_limit']);
const BUSY_MACHINE = new Set(['machine_not_running', 'runtime_not_ready', 'operation_conflict']);

/** Ordered InstaBox error rules (https://instabox.sh/docs/errors): the first match wins. */
const INSTABOX_ERROR_RULES: ErrorRule<InstaboxErrorContext>[] = [
  {
    when: (e) => e.code === 'missing_scope' || e.code === 'insufficient_scope',
    map: (e) => ({
      kind: 'auth',
      message: e.requiredScopes.length
        ? `${e.message} (the API key needs one of: ${e.requiredScopes.join(', ')})`
        : e.message,
    }),
  },
  // A size or template the plan does not include is not a bad credential.
  {
    when: (e) => NOT_ALLOWED_BY_PLAN.has(e.code),
    map: (e) => ({ kind: 'unsupported', message: e.message }),
  },
  credentialErrorRule<InstaboxErrorContext>(),
  { when: (e) => e.status === 402, map: (e) => ({ kind: 'quota', message: e.message }) },
  { when: (e) => e.status === 404, map: (e) => ({ kind: 'not-found', message: e.message }) },
  // A max-run cooldown or an abuse lock: waking is refused until it ends.
  {
    when: (e) => e.code === 'machine_cooldown',
    map: (e) => ({ kind: 'unavailable', message: e.message, retryAfterMs: e.retryAfterMs() }),
  },
  {
    when: (e) => BUSY_MACHINE.has(e.code),
    map: (e) => ({ kind: 'unavailable', message: e.message, retryAfterMs: 3_000 }),
  },
  // Machine starts per minute, or a retryable concurrency limit (exec).
  ...transientErrorRules<InstaboxErrorContext>((e) => e.code === 'rate_limited' || e.retryable),
];

const mapInstaboxError = (res: Response, body: any) =>
  mapByRules(INSTABOX_ERROR_RULES, errorContext(res, body));

/** The new machine of a `create` operation. */
function machineHandle(body: any): ResultAsync<SandboxHandle, SandboxError> {
  return typeof body?.machineId === 'string'
    ? okAsync({ providerId: INSTABOX_PROVIDER_ID, sandboxId: body.machineId })
    : errAsync({ kind: 'provider', message: 'InstaBox create returned no machine id' });
}

/** A template snapshot's status → its ref, `null` while saving, or an error. */
function readySnapshotId(body: any, name: string): ResultAsync<string | null, SandboxError> {
  if (body?.status === 'failed') {
    return errAsync({ kind: 'provider', message: `InstaBox failed to save ${name}` });
  }
  return okAsync(body?.status === 'ready' ? String(body.id) : null);
}

export interface InstaboxProviderOptions {
  fetch?: Fetch;
  /** Injected wait for deterministic tests. */
  sleep?: (ms: number) => PromiseLike<void>;
  /** Idempotency keys of lifecycle calls (overridable in tests). */
  newKey?: () => string;
  /** Polling cadence and limits of the template build (overridable in tests). */
  pollMs?: number;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  snapshotTimeoutMs?: number;
  /** Per-request cap, so a hung InstaBox call cannot block an operation forever. */
  requestTimeoutMs?: number;
}

export function createInstaboxProvider(
  apiKey: string,
  config: InstaboxConfig = {},
  options: InstaboxProviderOptions = {},
): SandboxProvider {
  const newKey = options.newKey ?? (() => randomUUID());
  const { call, requestTimeoutMs } = createJsonApi({
    label: 'InstaBox',
    baseUrl: config.apiBaseUrl ?? DEFAULT_BASE_URL,
    authHeaders: { 'X-API-Key': apiKey },
    fetch: options.fetch,
    requestTimeoutMs: options.requestTimeoutMs,
    mapError: mapInstaboxError,
  });
  const poll = createPoller(options.pollMs ?? 3_000, options.sleep);

  /** A lifecycle mutation: InstaBox requires an `Idempotency-Key` on each. */
  const mutate = (path: string, body: unknown = {}) =>
    call('POST', path, { body, headers: { 'Idempotency-Key': newKey() } });

  /** A guarded delete: InstaBox wants the resource id echoed back. */
  const remove = (path: string, id: string) =>
    ignoreNotFound(
      call('DELETE', path, { headers: { 'Idempotency-Key': newKey(), 'X-Confirm-Delete': id } }),
    );

  const machinePath = (handle: SandboxHandle) =>
    `/v1/machines/${encodeURIComponent(handle.sandboxId)}`;

  const listSnapshots = () =>
    call('GET', '/v1/snapshots').map((body): any[] =>
      Array.isArray(body?.snapshots) ? body.snapshots : [],
    );

  const deleteSnapshot = (id: string) => remove(`/v1/snapshots/${encodeURIComponent(id)}`, id);

  /** Stopped with its storage fully saved: a snapshot then copies no data. */
  const isStoppedAndSynced = (handle: SandboxHandle) =>
    call('GET', machinePath(handle)).map((body) =>
      body?.state === 'stopped' && body?.storage?.synced !== false ? true : null,
    );

  /** Install → stop → snapshot → wait until the snapshot is ready. */
  const buildOn = (handle: SandboxHandle, req: TemplateBuildRequest, name: string) =>
    installRunner(provider, handle, req, {
      poll,
      readyTimeoutMs: options.readyTimeoutMs,
      execTimeoutMs: MAX_EXEC_SECONDS * 1000,
    })
      .andThen(() => provider.stop(handle))
      .andThen(() =>
        poll(
          'template sandbox stop',
          options.stopTimeoutMs ?? 5 * 60_000,
          () => isStoppedAndSynced(handle),
          req.signal,
        ),
      )
      .andThen(() => mutate(`${machinePath(handle)}/snapshots`, { name }))
      .andThen((snapshot) =>
        poll(
          'template snapshot save',
          options.snapshotTimeoutMs ?? 15 * 60_000,
          () =>
            call('GET', `/v1/snapshots/${encodeURIComponent(snapshot?.id)}`).andThen((body) =>
              readySnapshotId(body, name),
            ),
          req.signal,
        ),
      )
      .map((id): TemplateRef => ({ providerId: INSTABOX_PROVIDER_ID, ref: id }));

  /**
   * The snapshot already holding `name`: a ready one is the template (another
   * build finished it), a pending one is a build still saving (retry later),
   * and a failed one is deleted so the name is free again. Yields the ready
   * template, or null when a build may start.
   */
  const settleExistingSnapshot = (name: string) =>
    listSnapshots().andThen((snapshots): ResultAsync<TemplateRef | null, SandboxError> => {
      const named = snapshots.filter((s) => s?.name === name);
      const ready = named.find((s) => s.status === 'ready');
      if (ready) return okAsync({ providerId: INSTABOX_PROVIDER_ID, ref: String(ready.id) });
      if (named.some((s) => s.status === 'pending')) {
        return errAsync({
          kind: 'unavailable',
          message: `InstaBox snapshot ${name} is still saving`,
          retryAfterMs: 15_000,
        });
      }
      return ResultAsync.combine(named.map((s) => deleteSnapshot(String(s.id)))).map(() => null);
    });

  const provider: SandboxProvider = {
    id: INSTABOX_PROVIDER_ID,
    capabilities: () => instaboxCapabilities,

    validate: () =>
      call('GET', '/v1/me').andThen((body) =>
        body?.inviteRequired && !body?.activated
          ? errAsync<never, SandboxError>({
              kind: 'quota',
              message: 'InstaBox account is not activated yet (redeem an invite code first)',
            })
          : okAsync({ accountLabel: `instabox (${body?.login ?? body?.email ?? 'account'})` }),
      ),

    resolveTemplate: (serverVersion) => {
      const name = instaboxTemplateName(serverVersion);
      return listSnapshots().andThen((snapshots): ResultAsync<TemplateRef, SandboxError> => {
        const snapshot = snapshots.find((s) => s?.name === name);
        if (!snapshot || snapshot.status === 'failed') {
          return errAsync({
            kind: 'template-missing',
            message: `InstaBox snapshot ${name} not found`,
          });
        }
        if (snapshot.status === 'pending') {
          return errAsync({
            kind: 'unavailable',
            message: `InstaBox snapshot ${name} is still saving`,
            retryAfterMs: 15_000,
          });
        }
        return okAsync({ providerId: INSTABOX_PROVIDER_ID, ref: String(snapshot.id) });
      });
    },

    create: (req: CreateSandboxRequest) => {
      const size = instaboxCapabilities.sizes.find((s) => s.id === req.sizeId);
      return call('POST', '/v1/machines', {
        headers: { 'Idempotency-Key': req.idempotencyKey },
        body: {
          ...(req.template ? { snapshotId: req.template.ref } : {}),
          ...(size ? { vcpus: size.vcpu, memMiB: size.memoryGb * 1024 } : {}),
          ...(Object.keys(req.env).length ? { env: req.env } : {}),
          ...(config.autoSuspendAfterSeconds !== undefined
            ? { autoSuspendAfterSeconds: config.autoSuspendAfterSeconds }
            : {}),
          // One-shot safety stop: the disk is kept and a start brings it back.
          ...(req.lifetimeMs ? { archiveSeconds: deadlineSeconds(req.lifetimeMs) } : {}),
          metadata: { 'funny-thread': req.ownerKey },
        },
      }).andThen(machineHandle);
    },

    status: (handle) =>
      call('GET', machinePath(handle)).map((body): SandboxStatus => {
        const providerState: string = body?.state ?? 'unknown';
        const mapped = STATE_MAP[providerState] ?? 'failed';
        return {
          // Running but not yet accepting exec / files / SSH: still booting.
          state: mapped === 'running' && body?.runtime?.ready === false ? 'provisioning' : mapped,
          providerState,
          detail: body?.lastError?.message ?? undefined,
        };
      }),

    // A paused machine refuses `stop` (409); its disk is kept either way.
    stop: (handle) =>
      provider
        .status(handle)
        .andThen((status) =>
          status.state === 'stopped'
            ? okAsync(undefined)
            : mutate(`${machinePath(handle)}/stop`).map(() => undefined),
        ),

    // `start` resumes a paused machine and boots a stopped one.
    resume: (handle) => mutate(`${machinePath(handle)}/start`).map(() => undefined),

    extendLifetime: () =>
      errAsync({ kind: 'unsupported', message: 'InstaBox has no extendable lifetime cap' }),

    destroy: (handle) => remove(machinePath(handle), handle.sandboxId),

    exec: (handle, command, opts) => {
      const timeoutSeconds = execTimeoutSeconds(opts?.timeoutMs, MAX_EXEC_SECONDS);
      // The request waits for the command: its cap is the command's plus slack.
      return call('POST', `${machinePath(handle)}/exec`, {
        body: { cmd: command, timeoutSeconds, noHistory: true },
        timeoutMs: timeoutSeconds * 1000 + requestTimeoutMs,
      }).map(execResultFrom);
    },

    // A private port; its token is only shown when issued, so every call rotates it.
    exposePort: (handle, port) =>
      mutate(`${machinePath(handle)}/ports`, {
        port,
        name: 'funny runner link',
        access: 'private',
        rotateToken: true,
      }).andThen((body): ResultAsync<SandboxIngress, SandboxError> => {
        if (typeof body?.url !== 'string' || !body.url || typeof body?.token !== 'string') {
          return errAsync({
            kind: 'provider',
            message: 'InstaBox publish returned no URL or token',
          });
        }
        return okAsync({ url: body.url, headers: { Authorization: `Bearer ${body.token}` } });
      }),

    listTemplates: () =>
      listSnapshots().map((snapshots): TemplateRef[] =>
        snapshots
          .filter((s) => String(s?.name ?? '').startsWith(TEMPLATE_PREFIX))
          .map((s) => ({ providerId: INSTABOX_PROVIDER_ID, ref: String(s.id) })),
      ),

    deleteTemplate: (template) => deleteSnapshot(template.ref),

    /**
     * Throwaway machine → install script → stop → snapshot → poll until ready.
     * The throwaway machine is deleted whether the build succeeds or not, and
     * carries a `deleteAfterSeconds` deadline in case the server dies mid-build.
     */
    buildTemplate: (req) => {
      const name = instaboxTemplateName(req.serverVersion);
      // Snapshot names are unique: settle one that already holds the name first.
      return settleExistingSnapshot(name).andThen((existing) =>
        existing
          ? okAsync<TemplateRef, SandboxError>(existing)
          : call('POST', '/v1/machines', {
              headers: { 'Idempotency-Key': `funny-template:${name}:${newKey()}` },
              body: {
                deleteAfterSeconds: 2 * 3600,
                metadata: { 'funny-template': req.serverVersion },
              },
            })
              .andThen(machineHandle)
              .andThen((handle) =>
                withThrowawayMachine(handle, buildOn(handle, req, name), provider.destroy),
              ),
      );
    },
  };
  return provider;
}

/** Production registry entry (registered in `provider-catalog.ts`). */
export const instaboxProviderEntry: SandboxProviderEntry<InstaboxConfig> = {
  id: INSTABOX_PROVIDER_ID,
  displayName: 'InstaBox',
  configSchema: instaboxConfigSchema,
  capabilities: instaboxCapabilities,
  create: ({ credential, config }) => createInstaboxProvider(credential, config),
};
