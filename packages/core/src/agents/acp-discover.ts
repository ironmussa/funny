/**
 * Manifest-driven ACP model discovery. Spawns a provider's ACP CLI just long
 * enough to call `initialize` + `newSession`, reads the advertised
 * `models.availableModels`, then tears the child down. The session/new response
 * shape is identical across pi / cursor / opencode
 * (`models.availableModels: [{ modelId, name }]` + `models.currentModelId`), so
 * one function serves all dynamic-catalog ACP providers — parameterized by the
 * {@link ProviderManifest}.
 *
 * Never throws — every failure maps to a typed `{ ok: false }` result so callers
 * can decide between "show error" and "show empty + configure" UX.
 */

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { Readable, Writable } from 'stream';

import type { ProviderManifest } from '@funny/shared/provider-manifest';
import { resolveSpawnCommand } from '@funny/shared/provider-manifest';

import { killProcessTree } from './base-process.js';

export interface DiscoveredAcpModel {
  /** ID accepted by the provider's set-model method (e.g. `opencode/gpt-5-nano/high`). */
  modelId: string;
  /** Display label as advertised by the provider. */
  name: string;
}

export type DiscoverAcpModelsResult =
  | { ok: true; models: DiscoveredAcpModel[]; currentModelId: string | null }
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

export interface DiscoverAcpModelsOptions {
  /** Working directory to pass to `session/new`. Defaults to OS tmpdir. */
  cwd?: string;
  /** Hard timeout in ms. Defaults to 15s — cold-start first-byte can be slow. */
  timeoutMs?: number;
  /** Extra env vars merged on top of `process.env`. */
  env?: Record<string, string | undefined>;
}

export async function discoverAcpModels(
  manifest: ProviderManifest,
  opts: DiscoverAcpModelsOptions = {},
): Promise<DiscoverAcpModelsResult> {
  const cwd = opts.cwd ?? tmpdir();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const label = manifest.label;

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
  const { command, args } = resolveSpawnCommand(manifest.spawn);

  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    shell: process.platform === 'win32',
    // Match long-lived ACP agents: isolate a POSIX process group so cleanup
    // can terminate any MCP grandchildren the discovery CLI starts.
    detached: process.platform !== 'win32',
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
    killProcessTree(child);
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<DiscoverAcpModelsResult>((resolve) => {
    timer = setTimeout(() => {
      cleanup();
      resolve({
        ok: false,
        reason: 'timeout',
        message: `${label} did not respond within ${timeoutMs}ms`,
      });
    }, timeoutMs);
  });

  const work = (async (): Promise<DiscoverAcpModelsResult> => {
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
        clientInfo: { name: `funny-${manifest.id}-discover`, version: '1.0.0' },
        clientCapabilities: {},
      });

      const sessionResponse = await connection.newSession({ cwd, mcpServers: [] });
      const models = (sessionResponse as { models?: { availableModels?: unknown } }).models;
      const raw = Array.isArray(models?.availableModels) ? models!.availableModels : [];

      const discovered: DiscoveredAcpModel[] = [];
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
          message: `${label} returned an empty model list — make sure it is authenticated on your runner.`,
        };
      }
      return { ok: true, models: discovered, currentModelId };
    } catch (err) {
      cleanup();
      const message = (err as Error)?.message ?? String(err);
      // Providers surface a JSON-RPC error / auth_required when not logged in.
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
