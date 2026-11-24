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
import { tmpdir } from 'os';

import { runAsync } from '@funny/shared/async';
import type { ProviderManifest } from '@funny/shared/provider-manifest';
import { resolveSpawnCommand } from '@funny/shared/provider-manifest';

import { spawnAcpProbe } from './acp-probe-spawn.js';
import { childAcpStream } from './acp-stream.js';
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

  // `/unstable` keeps the full v1 surface the 1.x default import exposed
  // (session/new `models`, prompt `usage`); the wire protocol is still ACP v1.
  let SDK: typeof import('@agentclientprotocol/sdk/unstable');
  try {
    SDK = await import('@agentclientprotocol/sdk/unstable');
  } catch {
    return {
      ok: false,
      reason: 'sdk_missing',
      message: '@agentclientprotocol/sdk is not installed',
    };
  }

  const { client, methods, ndJsonStream } = SDK;
  const { command, args } = resolveSpawnCommand(manifest.spawn);

  // Isolated process group so cleanup can terminate MCP grandchildren.
  const spawned = await spawnAcpProbe(command, args, cwd, opts.env);
  if (spawned.isErr()) return { ok: false, reason: 'spawn_failed', message: spawned.error };
  const child = spawned.value;

  let closeConnection: (() => void) | null = null;
  const cleanup = () => {
    closeConnection?.();
    closeConnection = null;
    killProcessTree(child);
  };

  const work = (async (): Promise<DiscoverAcpModelsResult> => {
    const connection = client({ name: `funny-${manifest.id}-discover` })
      .onNotification(methods.client.session.update, () => {})
      .onRequest(methods.client.session.requestPermission, ({ params }) => ({
        outcome: { outcome: 'selected', optionId: params.options[0]?.optionId ?? '' },
      }))
      .connect(childAcpStream(child, ndJsonStream));
    closeConnection = () => connection.close();
    const agent = connection.agent;

    try {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientInfo: { name: `funny-${manifest.id}-discover`, version: '1.0.0' },
        clientCapabilities: {},
      });

      const sessionResponse = await agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      // SAFETY: `models` is an unstable ACP extension the SDK response type does not
      // declare; it is only read through optional chaining and `Array.isArray` below,
      // so a provider that omits it yields an empty list.
      const models = (sessionResponse as { models?: { availableModels?: unknown } }).models;
      const raw = Array.isArray(models?.availableModels) ? models!.availableModels : [];

      const discovered: DiscoveredAcpModel[] = [];
      for (const m of raw) {
        if (!m || typeof m !== 'object') continue;
        // SAFETY: `m` was checked to be a non-null object above; `modelId` is read
        // optionally and coerced with `String`, so a missing one is skipped.
        const modelId = String((m as { modelId?: unknown }).modelId ?? '').trim();
        if (!modelId) continue;
        // SAFETY: `m` is a non-null object (checked above); a missing `name` falls back
        // to the model id.
        const name = String((m as { name?: unknown }).name ?? modelId);
        discovered.push({ modelId, name });
      }

      // SAFETY: `models` is the optional object read above; the second assertion only
      // runs after the `typeof === 'string'` check on the same field.
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
      // SAFETY: the ACP SDK rejects with Error instances or JSON-RPC error objects that
      // carry `message`; anything else has no `message` and falls back to `String(err)`.
      const message = (err as Error)?.message ?? String(err);
      // Providers surface a JSON-RPC error / auth_required when not logged in.
      if (/auth/i.test(message) || /login/i.test(message)) {
        return { ok: false, reason: 'auth_required', message };
      }
      return { ok: false, reason: 'agent_error', message };
    }
  })();

  try {
    return await runAsync(() => work, {
      timeoutMs,
      timeoutError: () => new Error('discovery timeout'),
    }).catch((): DiscoverAcpModelsResult => ({
      ok: false,
      reason: 'timeout',
      message: `${label} did not respond within ${timeoutMs}ms`,
    }));
  } finally {
    cleanup();
  }
}
