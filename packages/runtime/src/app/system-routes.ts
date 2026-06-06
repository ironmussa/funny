import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { getNativeGit } from '@funny/core/git';
import {
  getDefaultModel,
  getProviderModels,
  getProviderModelsWithLabels,
  PROVIDER_LABELS,
} from '@funny/shared/models';
import { getManifest } from '@funny/shared/provider-manifests';
import type { Hono } from 'hono';

import { log } from '../lib/logger.js';
import { wsBroker } from '../services/ws-broker.js';
import { resetBinaryCache } from '../utils/claude-binary.js';
import { getAvailableProviders, resetProviderCache } from '../utils/provider-detection.js';

/**
 * Mounts the runtime's "system" endpoints (health, available shells, pi /
 * cursor model discovery, setup status, native-git build, bootstrap).
 * Pulled out of app.ts so the bootstrap file doesn't need spawnSync,
 * fs/path, provider-detection, claude-binary, or shared/models utilities.
 */
export function registerSystemRoutes(app: Hono): void {
  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/system/shells', (c) => {
    const { detectShells } =
      require('../services/shell-detector.js') as typeof import('../services/shell-detector.js');
    return c.json({ shells: detectShells() });
  });

  // Manifest-driven dynamic model discovery. One route serves every ACP
  // provider whose manifest declares `models.kind: 'dynamic'` (pi / cursor /
  // opencode); the `:provider` param keeps the existing per-provider URLs
  // (`/api/system/pi/models`, etc.) working unchanged. Static-catalog and
  // unknown providers get a 404.
  const MODELS_TTL_MS = 60_000;
  const modelsCache = new Map<string, { at: number; payload: unknown }>();
  app.get('/api/system/:provider/models', async (c) => {
    const provider = c.req.param('provider');
    const manifest = getManifest(provider);
    if (!manifest || manifest.models.kind !== 'dynamic') {
      return c.json(
        { ok: false, reason: 'unknown_provider', message: `No dynamic model discovery for '${provider}'` },
        404,
      );
    }

    const refresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
    const cached = modelsCache.get(provider);
    if (!refresh && cached && Date.now() - cached.at < MODELS_TTL_MS) {
      return c.json(cached.payload);
    }

    const { discoverAcpModels } = await import('@funny/core/agents');
    const result = await discoverAcpModels(manifest);
    const payload = result.ok
      ? {
          ok: true as const,
          models: result.models,
          currentModelId: result.currentModelId,
          discoveredAt: Date.now(),
        }
      : {
          ok: false as const,
          reason: result.reason,
          message: result.message ?? null,
          discoveredAt: Date.now(),
        };
    modelsCache.set(provider, { at: Date.now(), payload });
    if (!result.ok) {
      log.warn('acp model discovery failed', {
        namespace: `${provider}-discover`,
        reason: result.reason,
        message: result.message,
      });
    } else {
      log.info('acp model discovery ok', {
        namespace: `${provider}-discover`,
        count: result.models.length,
      });
    }
    return c.json(payload);
  });

  // (opencode model discovery is served by the generic `/api/system/:provider/models`
  // route above — master's separate opencode route was dropped in the merge.)

  app.get('/api/setup/status', async (c) => {
    resetProviderCache();
    resetBinaryCache();
    const providers = await getAvailableProviders();

    const providerInfo: Record<string, any> = {};
    for (const [name, info] of providers) {
      providerInfo[name] = {
        available: info.available,
        sdkAvailable: info.sdkAvailable,
        cliAvailable: info.cliAvailable,
        cliPath: info.cliPath ?? null,
        cliVersion: info.cliVersion ?? null,
        error: info.error ?? null,
        label: PROVIDER_LABELS[name] ?? name,
        defaultModel: info.available ? getDefaultModel(name as any) : null,
        models: info.available ? getProviderModels(name as any) : [],
        modelsWithLabels: info.available ? getProviderModelsWithLabels(name as any) : [],
      };
    }

    const claude = providers.get('claude');

    const nativeGitLoaded = getNativeGit() !== null;
    const nativeGitDisabled = process.env.FUNNY_DISABLE_NATIVE_GIT === '1';
    const nativeGitDir = resolve(import.meta.dir, '..', '..', '..', '..', 'native-git');
    const hasCargoToml = existsSync(join(nativeGitDir, 'Cargo.toml'));

    let rustAvailable = false;
    let rustVersion: string | null = null;
    try {
      const result = spawnSync('cargo', ['--version'], { timeout: 5000 });
      if (result.status === 0 && result.stdout) {
        rustVersion = result.stdout.toString().trim();
        rustAvailable = true;
      }
    } catch {
      // cargo not available
    }

    const platform = `${process.platform}-${process.arch}`;

    return c.json({
      providers: providerInfo,
      claudeCli: {
        available: claude?.cliAvailable ?? false,
        path: claude?.cliPath ?? null,
        error: !claude?.cliAvailable ? (claude?.error ?? 'Not available') : null,
        version: claude?.cliVersion ?? null,
      },
      agentSdk: {
        available: claude?.sdkAvailable ?? false,
      },
      nativeGit: {
        loaded: nativeGitLoaded,
        disabled: nativeGitDisabled,
        rustAvailable,
        rustVersion,
        platform,
        canBuild: rustAvailable && hasCargoToml,
      },
    });
  });

  let nativeGitBuildInProgress = false;
  app.post('/api/system/build-native-git', async (c) => {
    const userId = c.get('userId') as string;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    if (nativeGitBuildInProgress) {
      return c.json({ error: 'Build already in progress' }, 409);
    }

    const nativeGitDir = resolve(import.meta.dir, '..', '..', '..', '..', 'native-git');
    if (!existsSync(join(nativeGitDir, 'Cargo.toml'))) {
      return c.json({ error: 'native-git package not found' }, 404);
    }

    try {
      const check = spawnSync('cargo', ['--version'], { timeout: 5000 });
      if (check.status !== 0) {
        return c.json({ error: 'Rust toolchain not available' }, 400);
      }
    } catch {
      return c.json({ error: 'Rust toolchain not available' }, 400);
    }

    nativeGitBuildInProgress = true;

    const emitBuild = (type: string, data: unknown) => {
      wsBroker.emitToUser(userId, { type, threadId: '', data } as any);
    };

    emitBuild('native-git:build_status', { status: 'building' });

    const proc = Bun.spawn(['napi', 'build', '--platform', '--release'], {
      cwd: nativeGitDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    const streamReader = async (stream: ReadableStream<Uint8Array>, channel: string) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          emitBuild('native-git:build_output', {
            text: decoder.decode(value, { stream: true }),
            channel,
          });
        }
      } catch {
        // stream closed
      }
    };

    void streamReader(proc.stdout as ReadableStream<Uint8Array>, 'stdout');
    void streamReader(proc.stderr as ReadableStream<Uint8Array>, 'stderr');

    proc.exited.then((exitCode) => {
      nativeGitBuildInProgress = false;
      emitBuild('native-git:build_status', {
        status: exitCode === 0 ? 'completed' : 'failed',
        exitCode,
      });
    });

    return c.json({ status: 'started' });
  });

  app.get('/api/bootstrap', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    return c.json({ mode: 'local' });
  });
}
