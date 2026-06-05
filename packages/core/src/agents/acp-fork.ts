/**
 * @domain subdomain: Agent Process
 * @domain subdomain-type: core
 * @domain type: helper
 * @domain layer: domain
 *
 * Out-of-process ACP session fork: spawns the agent CLI just long enough to
 * call `unstable_forkSession()` against the source session, returns the new
 * sessionId, and tears the process down. Used by the runtime fork service
 * so that codex / gemini / pi / cursor conversations can be branched the
 * same way Claude SDK conversations are.
 */

import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';

import { resolveSpawnCommand } from '@funny/shared/provider-manifest';
import { getManifest, type KnownAcpProvider } from '@funny/shared/provider-manifests';

type AcpProvider = KnownAcpProvider;

/** Resolve the CLI command + args for an ACP provider from its manifest. */
function resolveAcpCommand(provider: AcpProvider): { command: string; args: string[] } {
  const manifest = getManifest(provider);
  // Unreachable for a KnownAcpProvider; fall back to the bare id defensively.
  if (!manifest) return { command: provider, args: [] };
  return resolveSpawnCommand(manifest.spawn);
}

/** Traverse a dotted capability path (e.g. `sessions.fork`) and test truthiness. */
function hasCapabilityPath(caps: Record<string, unknown> | undefined, path: string): boolean {
  let cur: unknown = caps;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return Boolean(cur);
}

export interface ForkAcpSessionOptions {
  provider: AcpProvider;
  sessionId: string;
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface ForkAcpSessionResult {
  /** Native ACP fork succeeded — the new session is owned by the agent's session store. */
  ok: true;
  newSessionId: string;
}

export interface ForkAcpSessionUnsupported {
  /** Agent did not advertise the `session.fork` capability. Caller should fall back. */
  ok: false;
  reason: 'capability_not_advertised' | 'agent_error' | 'spawn_failed';
  message?: string;
}

/**
 * Fork an ACP session out of process. Resolves with the new sessionId on
 * success; resolves with `{ ok: false }` if the agent doesn't advertise the
 * capability or the call fails — callers can then decide whether to fall back
 * to a non-native "copy DB messages" branch.
 */
export async function forkAcpSession(
  opts: ForkAcpSessionOptions,
): Promise<ForkAcpSessionResult | ForkAcpSessionUnsupported> {
  let SDK: typeof import('@agentclientprotocol/sdk');
  try {
    SDK = await import('@agentclientprotocol/sdk');
  } catch {
    return {
      ok: false,
      reason: 'spawn_failed',
      message: 'ACP SDK (@agentclientprotocol/sdk) is not installed',
    };
  }

  const { ClientSideConnection, ndJsonStream } = SDK;
  const { command, args } = resolveAcpCommand(opts.provider);

  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    shell: process.platform === 'win32',
  });

  // Drain stderr so the child doesn't block on a full pipe buffer.
  child.stderr?.on('data', () => {});

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn_failed',
      message: (err as Error)?.message,
    };
  }

  const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const inputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(outputStream, inputStream);

  // Minimal client — fork shouldn't trigger sessionUpdate / requestPermission,
  // but the SDK requires both methods to be present.
  const connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async (params) => ({
        outcome: { outcome: 'selected', optionId: params.options[0]?.optionId ?? '' },
      }),
    }),
    stream,
  );

  const cleanup = () => {
    if (!child.killed) child.kill('SIGTERM');
  };

  try {
    const initResult = await connection.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'funny-fork', version: '1.0.0' },
      clientCapabilities: {},
    });

    // Each manifest declares where its agent advertises native fork under
    // `agentCapabilities` — `sessions.fork` for codex/gemini/pi/cursor,
    // `sessionCapabilities.fork` for opencode.
    const caps = initResult.agentCapabilities as Record<string, unknown> | undefined;
    const paths = getManifest(opts.provider)?.forkCapabilityPaths ?? [
      'sessions.fork',
      'sessionCapabilities.fork',
    ];
    if (!paths.some((p) => hasCapabilityPath(caps, p))) {
      cleanup();
      return { ok: false, reason: 'capability_not_advertised' };
    }

    const result = await connection.unstable_forkSession({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mcpServers: [],
    });

    cleanup();
    return { ok: true, newSessionId: result.sessionId };
  } catch (err) {
    cleanup();
    return {
      ok: false,
      reason: 'agent_error',
      message: (err as Error)?.message,
    };
  }
}
