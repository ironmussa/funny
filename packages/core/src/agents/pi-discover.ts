/**
 * @domain subdomain: Agent Process
 * @domain subdomain-type: core
 * @domain type: helper
 * @domain layer: domain
 *
 * Out-of-process pi model discovery: spawns `pi-acp` long enough to call
 * `initialize` + `newSession`, reads the `models.availableModels` it
 * advertises, then tears the child down. Returned IDs are in the
 * `provider/modelId` shape that pi-acp's `unstable_setSessionModel` accepts.
 *
 * Used by the runtime to populate the client's pi model selector dynamically
 * — the funny package no longer hardcodes pi's model list since pi-mono
 * routes through several upstream providers and the catalog changes per
 * pi release.
 */

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { Readable, Writable } from 'stream';

export interface DiscoveredPiModel {
  /** ID in `provider/modelId` form, ready to pass to `unstable_setSessionModel`. */
  modelId: string;
  /** Display label as advertised by pi-acp (e.g. `google/Gemini 3.1 Pro Preview`). */
  name: string;
}

export type DiscoverPiModelsResult =
  | { ok: true; models: DiscoveredPiModel[]; currentModelId: string | null }
  | {
      ok: false;
      reason:
        | 'spawn_failed'
        | 'sdk_missing'
        | 'auth_required'
        | 'agent_error'
        | 'no_models'
        | 'timeout';
      message?: string;
    };

interface DiscoverPiModelsOptions {
  /** Working directory to pass to `session/new`. Defaults to OS tmpdir so we don't pollute a real repo. */
  cwd?: string;
  /** Hard timeout in ms. Defaults to 15s — pi-acp can be slow to first-byte. */
  timeoutMs?: number;
  /** Extra env vars merged on top of `process.env`. */
  env?: Record<string, string | undefined>;
}

function resolvePiAcpCommand(): { command: string; args: string[] } {
  const explicit = process.env.PI_ACP_BINARY_PATH || process.env.ACP_PI_BIN;
  if (explicit) return { command: explicit, args: [] };
  if (process.env.PI_ACP_USE_NPX === '1') {
    return { command: 'npx', args: ['-y', 'pi-acp'] };
  }
  return { command: 'pi-acp', args: [] };
}

/**
 * Spawn pi-acp once and read the models it advertises. The function never
 * throws — every failure is mapped to a typed `{ ok: false }` result so
 * callers can decide between "show error" and "show empty + configure" UX.
 */
export async function discoverPiModels(
  opts: DiscoverPiModelsOptions = {},
): Promise<DiscoverPiModelsResult> {
  const cwd = opts.cwd ?? tmpdir();
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let SDK: typeof import('@agentclientprotocol/sdk');
  try {
    SDK = await import('@agentclientprotocol/sdk');
  } catch {
    return {
      ok: false,
      reason: 'sdk_missing',
      message: '@agentclientprotocol/sdk is not installed',
    };
  }

  const { ClientSideConnection, ndJsonStream } = SDK;
  const { command, args } = resolvePiAcpCommand();

  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    shell: process.platform === 'win32',
  });

  child.stderr?.on('data', () => {});

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (err) {
    return { ok: false, reason: 'spawn_failed', message: (err as Error)?.message };
  }

  const cleanup = () => {
    if (!child.killed) child.kill('SIGTERM');
  };

  // Timeout wrapper — pi-acp could hang on auth refresh, never resolve.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<DiscoverPiModelsResult>((resolve) => {
    timer = setTimeout(() => {
      cleanup();
      resolve({
        ok: false,
        reason: 'timeout',
        message: `pi-acp did not respond within ${timeoutMs}ms`,
      });
    }, timeoutMs);
  });

  const work = (async (): Promise<DiscoverPiModelsResult> => {
    const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const inputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(outputStream, inputStream);

    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async (params) => ({
          outcome: { outcome: 'selected', optionId: params.options[0]?.optionId ?? '' },
        }),
      }),
      stream,
    );

    try {
      await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'funny-pi-discover', version: '1.0.0' },
        clientCapabilities: {},
      });

      const sessionResponse = await connection.newSession({ cwd, mcpServers: [] });
      const models = (sessionResponse as { models?: { availableModels?: unknown } }).models;
      const raw = Array.isArray(models?.availableModels) ? models!.availableModels : [];

      const discovered: DiscoveredPiModel[] = [];
      for (const m of raw) {
        if (!m || typeof m !== 'object') continue;
        const modelId = String((m as { modelId?: unknown }).modelId ?? '').trim();
        if (!modelId) continue;
        const name = String((m as { name?: unknown }).name ?? modelId);
        discovered.push({ modelId, name });
      }

      const currentModelId =
        typeof (models as { currentModelId?: unknown } | undefined)?.currentModelId === 'string'
          ? (models as { currentModelId: string }).currentModelId
          : null;

      cleanup();

      if (discovered.length === 0) {
        return {
          ok: false,
          reason: 'no_models',
          message: 'pi-acp returned an empty model list — pi may not be authenticated.',
        };
      }
      return { ok: true, models: discovered, currentModelId };
    } catch (err) {
      cleanup();
      const message = (err as Error)?.message ?? String(err);
      // pi-acp throws code -32000 with "Authentication required" when
      // `~/.pi/agent/auth.json` is empty or no provider has models.
      if (/auth/i.test(message)) {
        return { ok: false, reason: 'auth_required', message };
      }
      return { ok: false, reason: 'agent_error', message };
    }
  })();

  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    cleanup();
  }
}
