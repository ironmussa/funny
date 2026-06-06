/**
 * @domain subdomain: Agent Process
 * @domain subdomain-type: core
 * @domain type: helper
 * @domain layer: domain
 *
 * Out-of-process opencode model discovery: spawns `opencode acp` long enough to
 * call `initialize` + `newSession`, reads the `models.availableModels` it
 * advertises, then tears the child down. Returned IDs are accepted by opencode's
 * `session/set_model` method.
 *
 * Used by the runtime to populate the client's opencode model selector
 * dynamically — funny does not hardcode opencode's catalog because opencode
 * routes to many underlying providers configured by the user and adds models
 * faster than we can keep a static list current. The session/new response shape
 * is identical to cursor's (`models.availableModels: [{ modelId, name }]` +
 * `models.currentModelId`), so this mirrors cursor-discover.ts.
 */

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { Readable, Writable } from 'stream';

export interface DiscoveredOpenCodeModel {
  /** ID accepted by opencode's `session/set_model` (e.g. `opencode/gpt-5-nano/high`). */
  modelId: string;
  /** Display label as advertised by opencode (e.g. `OpenCode Zen/GPT-5 Nano`). */
  name: string;
}

export type DiscoverOpenCodeModelsResult =
  | { ok: true; models: DiscoveredOpenCodeModel[]; currentModelId: string | null }
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

interface DiscoverOpenCodeModelsOptions {
  /** Working directory to pass to `session/new`. Defaults to OS tmpdir so we don't pollute a real repo. */
  cwd?: string;
  /** Hard timeout in ms. Defaults to 15s — opencode can be slow to first-byte on cold start. */
  timeoutMs?: number;
  /** Extra env vars merged on top of `process.env`. */
  env?: Record<string, string | undefined>;
}

function resolveOpenCodeAcpCommand(): { command: string; args: string[] } {
  const explicit = process.env.OPENCODE_BIN || process.env.ACP_OPENCODE_BIN;
  if (explicit) return { command: explicit, args: ['acp'] };
  if (process.env.OPENCODE_ACP_USE_NPX === '1') {
    return { command: 'npx', args: ['-y', 'opencode-ai', 'acp'] };
  }
  return { command: 'opencode', args: ['acp'] };
}

/**
 * Spawn opencode once and read the models it advertises. Never throws —
 * every failure is mapped to a typed `{ ok: false }` result so callers can
 * decide between "show error" and "show empty + configure" UX.
 */
export async function discoverOpenCodeModels(
  opts: DiscoverOpenCodeModelsOptions = {},
): Promise<DiscoverOpenCodeModelsResult> {
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
  const { command, args } = resolveOpenCodeAcpCommand();

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
  const timeoutPromise = new Promise<DiscoverOpenCodeModelsResult>((resolve) => {
    timer = setTimeout(() => {
      cleanup();
      resolve({
        ok: false,
        reason: 'timeout',
        message: `opencode did not respond within ${timeoutMs}ms`,
      });
    }, timeoutMs);
  });

  const work = (async (): Promise<DiscoverOpenCodeModelsResult> => {
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
        clientInfo: { name: 'funny-opencode-discover', version: '1.0.0' },
        clientCapabilities: {},
      });

      const sessionResponse = await connection.newSession({ cwd, mcpServers: [] });
      const models = (sessionResponse as { models?: { availableModels?: unknown } }).models;
      const raw = Array.isArray(models?.availableModels) ? models!.availableModels : [];

      const discovered: DiscoveredOpenCodeModel[] = [];
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
            'opencode returned an empty model list — run `opencode auth login` on your runner.',
        };
      }
      return { ok: true, models: discovered, currentModelId };
    } catch (err) {
      cleanup();
      const message = (err as Error)?.message ?? String(err);
      // opencode surfaces a JSON-RPC error / auth_required when the user has not
      // logged in (`opencode auth login`).
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
