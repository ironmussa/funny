/**
 * In-memory sandbox provider for tests and for the shared contract suite.
 * Configurable to behave like a disk-preserving provider (Boat-like) or an
 * ephemeral one, and to inject provider failures.
 */

import { errAsync, okAsync, type ResultAsync } from 'neverthrow';
import { z } from 'zod';

import type {
  CreateSandboxRequest,
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

const FAKE_PROVIDER_ID = 'fake';

type FakeState = 'running' | 'stopped';

interface FakeSandbox {
  request: CreateSandboxRequest;
  state: FakeState;
  lifetimeMs?: number;
  /** Simulates the provider dropping a stopped disk after retention. */
  expired: boolean;
}

export interface FakeProviderOptions {
  stopPreservesDisk?: boolean;
  maxLifetimeMs?: number | null;
  validCredential?: string;
  templates?: string[];
  /** Base URL `exposePort` publishes on (`<base>/<sandboxId>/<port>`); absent: no ingress. */
  ingressBaseUrl?: string;
}

function fakeCapabilities(opts: FakeProviderOptions = {}): SandboxCapabilities {
  const stopPreservesDisk = opts.stopPreservesDisk ?? true;
  return {
    stopPreservesDisk,
    stoppedRetentionMs: stopPreservesDisk ? 14 * 24 * 60 * 60 * 1000 : null,
    maxLifetimeMs: opts.maxLifetimeMs === undefined ? 30 * 24 * 60 * 60 * 1000 : opts.maxLifetimeMs,
    sizes: [
      { id: 'small', vcpu: 2, memoryGb: 4 },
      { id: 'default', vcpu: 4, memoryGb: 8, default: true },
    ],
    env: { maxVars: 100, maxBytes: 64 * 1024 },
    preStopHook: 'none',
  };
}

export interface FakeSandboxProvider extends SandboxProvider {
  /** Test controls. */
  readonly sandboxes: ReadonlyMap<string, FakeSandbox>;
  readonly commands: ReadonlyArray<{ sandboxId: string; command: string }>;
  readonly templateBuilds: ReadonlyArray<TemplateBuildRequest>;
  readonly exposedPorts: ReadonlyArray<{ sandboxId: string; port: number }>;
  failNext(error: SandboxError): void;
  expire(sandboxId: string): void;
}

export function createFakeSandboxProvider(
  credential: string,
  opts: FakeProviderOptions = {},
): FakeSandboxProvider {
  const caps = fakeCapabilities(opts);
  const validCredential = opts.validCredential ?? 'fake-valid';
  const templates = new Set(opts.templates ?? ['0.0.0-test']);
  const sandboxes = new Map<string, FakeSandbox>();
  const commands: Array<{ sandboxId: string; command: string }> = [];
  const templateBuilds: TemplateBuildRequest[] = [];
  const byIdempotencyKey = new Map<string, string>();
  const exposedPorts: Array<{ sandboxId: string; port: number }> = [];
  let pendingFailure: SandboxError | null = null;
  let counter = 0;

  const guard = <T>(run: () => ResultAsync<T, SandboxError>): ResultAsync<T, SandboxError> => {
    if (credential !== validCredential) {
      return errAsync({ kind: 'auth', message: 'invalid credential' });
    }
    if (pendingFailure) {
      const failure = pendingFailure;
      pendingFailure = null;
      return errAsync(failure);
    }
    return run();
  };

  const find = (handle: SandboxHandle): ResultAsync<FakeSandbox, SandboxError> => {
    const sandbox = sandboxes.get(handle.sandboxId);
    if (!sandbox) return errAsync({ kind: 'not-found', message: handle.sandboxId });
    return okAsync(sandbox);
  };

  return {
    id: FAKE_PROVIDER_ID,
    sandboxes,
    commands,
    templateBuilds,
    exposedPorts,
    failNext: (error) => {
      pendingFailure = error;
    },
    expire: (sandboxId) => {
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox) sandbox.expired = true;
    },
    capabilities: () => caps,

    validate: () => guard(() => okAsync({ accountLabel: 'fake-account' })),

    resolveTemplate: (serverVersion) =>
      guard((): ResultAsync<TemplateRef, SandboxError> =>
        templates.has(serverVersion)
          ? okAsync({ providerId: FAKE_PROVIDER_ID, ref: `funny-runner-${serverVersion}` })
          : errAsync({ kind: 'template-missing', message: `no template for ${serverVersion}` }),
      ),

    create: (req) =>
      guard(() => {
        if (!caps.sizes.some((s) => s.id === req.sizeId)) {
          return errAsync({ kind: 'provider', message: `unknown size ${req.sizeId}` });
        }
        const existing = byIdempotencyKey.get(req.idempotencyKey);
        if (existing) return okAsync({ providerId: FAKE_PROVIDER_ID, sandboxId: existing });
        const sandboxId = `fake-${++counter}`;
        sandboxes.set(sandboxId, {
          request: req,
          state: 'running',
          lifetimeMs: req.lifetimeMs,
          expired: false,
        });
        byIdempotencyKey.set(req.idempotencyKey, sandboxId);
        return okAsync({ providerId: FAKE_PROVIDER_ID, sandboxId });
      }),

    status: (handle) =>
      guard(() =>
        find(handle).map((s): SandboxStatus => ({
          state: s.expired ? 'lost' : s.state,
          providerState: s.expired ? 'expired' : s.state,
        })),
      ),

    stop: (handle) =>
      guard(() => {
        if (!caps.stopPreservesDisk) {
          return errAsync({ kind: 'unsupported', message: 'ephemeral provider: destroy instead' });
        }
        return find(handle).map((s) => {
          s.state = 'stopped';
        });
      }),

    resume: (handle, resumeOpts) =>
      guard(() => {
        if (!caps.stopPreservesDisk) {
          return errAsync({ kind: 'unsupported', message: 'ephemeral provider: recreate instead' });
        }
        return find(handle).andThen((s) => {
          if (s.expired) return errAsync({ kind: 'expired' as const, message: 'disk expired' });
          s.state = 'running';
          if (resumeOpts?.lifetimeMs !== undefined) s.lifetimeMs = resumeOpts.lifetimeMs;
          return okAsync(undefined);
        });
      }),

    extendLifetime: (handle, lifetimeMs) =>
      guard(() => {
        if (caps.maxLifetimeMs === null) {
          return errAsync({ kind: 'unsupported', message: 'no provider lifetime cap' });
        }
        return find(handle).map((s) => {
          s.lifetimeMs = Math.min(lifetimeMs, caps.maxLifetimeMs!);
        });
      }),

    destroy: (handle) =>
      guard(() => {
        sandboxes.delete(handle.sandboxId);
        return okAsync(undefined);
      }),

    exec: (handle, command) =>
      guard(() =>
        find(handle).andThen((s) => {
          if (s.state !== 'running') {
            return errAsync({ kind: 'unavailable' as const, message: 'sandbox is not running' });
          }
          commands.push({ sandboxId: handle.sandboxId, command });
          return okAsync({ exitCode: 0, stdout: '', stderr: '' });
        }),
      ),

    ...(opts.ingressBaseUrl
      ? {
          exposePort: (handle: SandboxHandle, port: number) =>
            guard(() =>
              find(handle).map((): SandboxIngress => {
                exposedPorts.push({ sandboxId: handle.sandboxId, port });
                return {
                  url: `${opts.ingressBaseUrl}/${handle.sandboxId}/${port}`,
                  headers: { 'x-fake-ingress': 'token' },
                };
              }),
            ),
        }
      : {}),

    listTemplates: () =>
      guard(() =>
        okAsync(
          [...templates].map((version) => ({
            providerId: FAKE_PROVIDER_ID,
            ref: `funny-runner-${version}`,
          })),
        ),
      ),

    deleteTemplate: (template) =>
      guard(() => {
        templates.delete(template.ref.replace(/^funny-runner-/, ''));
        return okAsync(undefined);
      }),

    buildTemplate: (req) =>
      guard(() => {
        templateBuilds.push(req);
        templates.add(req.serverVersion);
        return okAsync({
          providerId: FAKE_PROVIDER_ID,
          ref: `funny-runner-${req.serverVersion}`,
        });
      }),
  };
}

/** Registry entry for tests; never registered in production. */
export function fakeSandboxProviderEntry(
  opts: FakeProviderOptions = {},
): SandboxProviderEntry<Record<string, never>> {
  return {
    id: FAKE_PROVIDER_ID,
    displayName: 'Fake (tests)',
    configSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
    capabilities: fakeCapabilities(opts),
    create: ({ credential }) => createFakeSandboxProvider(credential, opts),
  };
}
