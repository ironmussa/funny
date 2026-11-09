/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: port
 * @domain layer: domain
 *
 * Provider-neutral contract for per-thread sandboxes (change `thread-sandboxes`).
 *
 * A sandbox provider (Boat, E2B, Fly Machines, …) hosts ONE funny runner for
 * ONE thread. Everything outside `providers/` — lifecycle, routing, backup,
 * client — depends only on this file: provider differences are expressed as
 * declared `SandboxCapabilities` and normalized `SandboxError` kinds, never by
 * branching on the provider id.
 */

import type { ResultAsync } from 'neverthrow';

/** States shown on the thread, whatever the provider reports. */
const NORMALIZED_SANDBOX_STATES = [
  'provisioning',
  'running',
  'stopping',
  'stopped',
  'failed',
  'lost',
] as const;

export type NormalizedSandboxState = (typeof NORMALIZED_SANDBOX_STATES)[number];

export interface SandboxSize {
  id: string;
  vcpu: number;
  memoryGb: number;
  default?: boolean;
}

export interface SandboxCapabilities {
  /** `stop` keeps the disk and `resume` brings it back. False = ephemeral: idle means destroy. */
  stopPreservesDisk: boolean;
  /** How long a stopped disk is kept, or null if forever / not applicable. */
  stoppedRetentionMs: number | null;
  /** Provider-side lifetime cap support (auto-stop), or null when the provider has none. */
  maxLifetimeMs: number | null;
  sizes: SandboxSize[];
  env: { maxVars: number; maxBytes: number };
  /** Whether the template can run `funny runner pre-stop` before the provider stops the machine. */
  preStopHook: 'native' | 'none';
}

/** Opaque reference to a provider sandbox, persisted in `thread_sandboxes.provider_handle`. */
export interface SandboxHandle {
  providerId: string;
  sandboxId: string;
}

/** Provider-specific reference to the "funny runner" machine image for a server version. */
export interface TemplateRef {
  providerId: string;
  ref: string;
}

export type SandboxError =
  | { kind: 'auth'; message: string }
  | { kind: 'not-found'; message: string }
  /** The stopped disk is gone (retention elapsed): recover from the thread branch. */
  | { kind: 'expired'; message: string }
  /** Account limit (concurrency, plan, daily starts): not retryable. */
  | { kind: 'quota'; message: string }
  | { kind: 'rate-limited'; message: string; retryAfterMs?: number }
  | { kind: 'unavailable'; message: string; retryAfterMs?: number }
  | { kind: 'template-missing'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'provider'; message: string };

export function isRetryableSandboxError(e: SandboxError): boolean {
  return e.kind === 'rate-limited' || e.kind === 'unavailable';
}

export interface CreateSandboxRequest {
  threadId: string;
  sizeId: string;
  /** Runner template; omitted = the provider's base image (runner installed on the fly). */
  template?: TemplateRef;
  /** Enrollment bootstrap only (server URL, provisioning token, …). Never git or agent secrets. */
  env: Record<string, string>;
  lifetimeMs?: number;
  /** Same key + same request returns the same sandbox (`threadId:generation`). */
  idempotencyKey: string;
}

export interface SandboxStatus {
  state: NormalizedSandboxState;
  /** Raw provider state, for logs and debugging only. */
  providerState: string;
  detail?: string;
}

/**
 * A port of a sandbox reachable from the server (the provider's published
 * HTTPS URL), with what each request to it must carry. `url` may hold a
 * query (an access token); it is a credential and must not be logged.
 */
export interface SandboxIngress {
  url: string;
  headers: Record<string, string>;
}

export interface SandboxProvider {
  readonly id: string;
  capabilities(): SandboxCapabilities;
  validate(): ResultAsync<{ accountLabel: string }, SandboxError>;
  resolveTemplate(serverVersion: string): ResultAsync<TemplateRef, SandboxError>;
  create(req: CreateSandboxRequest): ResultAsync<SandboxHandle, SandboxError>;
  status(handle: SandboxHandle): ResultAsync<SandboxStatus, SandboxError>;
  /** Only meaningful when `capabilities().stopPreservesDisk`; otherwise returns `unsupported`. */
  stop(handle: SandboxHandle): ResultAsync<void, SandboxError>;
  resume(handle: SandboxHandle, opts?: { lifetimeMs?: number }): ResultAsync<void, SandboxError>;
  /** Only when `capabilities().maxLifetimeMs` is set; otherwise returns `unsupported`. */
  extendLifetime(handle: SandboxHandle, lifetimeMs: number): ResultAsync<void, SandboxError>;
  /** Idempotent: destroying a missing sandbox succeeds. */
  destroy(handle: SandboxHandle): ResultAsync<void, SandboxError>;
  /** Run a shell command in a running sandbox (writing its env file, starting the runner). */
  exec(
    handle: SandboxHandle,
    command: string,
    opts?: { timeoutMs?: number },
  ): ResultAsync<ExecResult, SandboxError>;
  /**
   * Publish `port` of a running sandbox on an HTTPS URL that only the server
   * can use (WebSockets included). Idempotent per sandbox and port; each call
   * returns usable credentials, rotating them when the provider cannot show
   * them again. Optional: without it the sandbox runner must reach a public
   * server URL (reverse runner link, `runner-link.ts`).
   */
  exposePort?(handle: SandboxHandle, port: number): ResultAsync<SandboxIngress, SandboxError>;
  /**
   * Build the runner template for `serverVersion` by running `installScript`
   * (with `scriptEnv`) on a throwaway machine and saving it. Optional: providers
   * without it need their template built out of band.
   */
  buildTemplate?(req: TemplateBuildRequest): ResultAsync<TemplateRef, SandboxError>;
  /** funny runner templates this provider holds (for cleanup of old versions). */
  listTemplates?(): ResultAsync<TemplateRef[], SandboxError>;
  /** Idempotent: deleting a missing template succeeds. */
  deleteTemplate?(template: TemplateRef): ResultAsync<void, SandboxError>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TemplateBuildRequest {
  serverVersion: string;
  installScript: string;
  scriptEnv: Record<string, string>;
  signal?: AbortSignal;
}

/** Picks the size to use: the requested one if declared, else the provider's default. */
export function resolveSandboxSize(
  caps: SandboxCapabilities,
  requested?: string,
): SandboxSize | undefined {
  if (requested) return caps.sizes.find((s) => s.id === requested);
  return caps.sizes.find((s) => s.default) ?? caps.sizes[0];
}

/** Checks a create-time env against the provider's declared limits. */
export function fitsEnvLimits(caps: SandboxCapabilities, env: Record<string, string>): boolean {
  const entries = Object.entries(env);
  if (entries.length > caps.env.maxVars) return false;
  const bytes = entries.reduce(
    (sum, [k, v]) => sum + Buffer.byteLength(k) + Buffer.byteLength(v),
    0,
  );
  return bytes <= caps.env.maxBytes;
}
