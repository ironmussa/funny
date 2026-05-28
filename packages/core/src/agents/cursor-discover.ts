/**
 * @domain subdomain: Agent Process
 * @domain subdomain-type: core
 * @domain type: helper
 * @domain layer: domain
 *
 * Out-of-process cursor model discovery: spawns `cursor-agent acp` long enough
 * to call `initialize` + `newSession`, reads the `models.availableModels` it
 * advertises, then tears the child down. Returned IDs are accepted by cursor's
 * `unstable_setSessionModel`.
 *
 * Used by the runtime to populate the client's cursor model selector
 * dynamically — funny does not hardcode cursor's catalog because Cursor adds
 * frontier models faster than we can keep a static list current.
 */

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { Readable, Writable } from 'stream';

export interface DiscoveredCursorModel {
  /** ID accepted by cursor's `unstable_setSessionModel`. */
  modelId: string;
  /** Display label as advertised by cursor-agent (e.g. `GPT-5`, `Claude Opus 4`). */
  name: string;
}

export type DiscoverCursorModelsResult =
  | { ok: true; models: DiscoveredCursorModel[]; currentModelId: string | null }
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

interface DiscoverCursorModelsOptions {
  /** Working directory to pass to `session/new`. Defaults to OS tmpdir so we don't pollute a real repo. */
  cwd?: string;
  /** Hard timeout in ms. Defaults to 15s — cursor-agent can be slow to first-byte on cold start. */
  timeoutMs?: number;
  /** Extra env vars merged on top of `process.env`. */
  env?: Record<string, string | undefined>;
}

function resolveCursorAcpCommand(): { command: string; args: string[] } {
  const explicit = process.env.CURSOR_BINARY_PATH || process.env.ACP_CURSOR_BIN;
  if (explicit) return { command: explicit, args: ['acp'] };
  if (process.env.CURSOR_ACP_USE_NPX === '1') {
    return { command: 'npx', args: ['-y', 'cursor-agent', 'acp'] };
  }
  return { command: 'cursor-agent', args: ['acp'] };
}

/**
 * Spawn cursor-agent once and read the models it advertises. Never throws —
 * every failure is mapped to a typed `{ ok: false }` result so callers can
 * decide between "show error" and "show empty + configure" UX.
 */
export async function discoverCursorModels(
  opts: DiscoverCursorModelsOptions = {},
): Promise<DiscoverCursorModelsResult> {
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
  const { command, args } = resolveCursorAcpCommand();

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

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<DiscoverCursorModelsResult>((resolve) => {
    timer = setTimeout(() => {
      cleanup();
      resolve({
        ok: false,
        reason: 'timeout',
        message: `cursor-agent did not respond within ${timeoutMs}ms`,
      });
    }, timeoutMs);
  });

  const work = (async (): Promise<DiscoverCursorModelsResult> => {
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
        clientInfo: { name: 'funny-cursor-discover', version: '1.0.0' },
        clientCapabilities: {},
      });

      const sessionResponse = await connection.newSession({ cwd, mcpServers: [] });
      const models = (sessionResponse as { models?: { availableModels?: unknown } }).models;
      const raw = Array.isArray(models?.availableModels) ? models!.availableModels : [];

      const discovered: DiscoveredCursorModel[] = [];
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
          message:
            'cursor-agent returned an empty model list — run `cursor-agent login` or set CURSOR_API_KEY.',
        };
      }
      return { ok: true, models: discovered, currentModelId };
    } catch (err) {
      cleanup();
      const message = (err as Error)?.message ?? String(err);
      // cursor-agent surfaces a JSON-RPC error with code -32000 and a message
      // like "Authentication required" when the user has not logged in and no
      // CURSOR_API_KEY is set.
      if (/auth/i.test(message) || /login/i.test(message)) {
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
