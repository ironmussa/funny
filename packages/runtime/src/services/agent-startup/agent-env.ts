import { mkdirSync } from 'node:fs';

import type { AgentProvider } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { getServices } from '../service-registry.js';

type EnvVars = Record<string, string>;

async function loadProviderKeyEnv(userId: string, provider: AgentProvider): Promise<EnvVars> {
  const { PROVIDER_KEY_REGISTRY } = await import('@funny/shared/models');
  const relevantKeys = PROVIDER_KEY_REGISTRY.filter(
    (k) => k.envVar && k.requiredByProviders?.includes(provider),
  );
  const env: EnvVars = {};
  for (const keyConfig of relevantKeys) {
    const keyValue = await getServices().profile.getProviderKey(userId, keyConfig.id);
    if (keyValue && keyConfig.envVar) {
      env[keyConfig.envVar] = keyValue;
    }
  }
  return env;
}

async function loadGitIdentityEnv(userId: string): Promise<EnvVars> {
  const gitIdentity = await getServices().profile.getGitIdentity(userId);
  if (!gitIdentity) return {};
  return {
    GIT_AUTHOR_NAME: gitIdentity.name,
    GIT_AUTHOR_EMAIL: gitIdentity.email,
    GIT_COMMITTER_NAME: gitIdentity.name,
    GIT_COMMITTER_EMAIL: gitIdentity.email,
  };
}

/**
 * Per-user temp assets dir — a browser-previewable scratch space OUTSIDE the
 * project tree for dev assets the agent generates (screenshots, renders,
 * clips). Authorized for media serving by resolveProjectScope (routes/files.ts)
 * and announced to the agent in the system prefix. Created 0700 because the OS
 * tmpdir parent is world-writable; reads stay gated by the realpath/scope
 * re-check.
 */
function prepareAssetsDirEnv(threadId: string, userId: string, assetsDir?: string): EnvVars {
  if (!assetsDir) return {};
  try {
    mkdirSync(assetsDir, { recursive: true, mode: 0o700 });
    return { FUNNY_ASSETS_DIR: assetsDir };
  } catch (assetsErr) {
    log.warn('Failed to prepare per-user assets dir', {
      namespace: 'media',
      threadId,
      userId,
      error: (assetsErr as Error).message,
    });
    return {};
  }
}

/**
 * Resolve per-user API keys, git identity and the assets dir for agent
 * subprocesses. Returns undefined when nothing applies (no user, or no
 * configured values) so the orchestrator keeps the inherited environment.
 */
export async function buildAgentEnv(input: {
  threadId: string;
  userId?: string;
  provider: AgentProvider;
  assetsDir?: string;
}): Promise<EnvVars | undefined> {
  const { threadId, userId, provider, assetsDir } = input;
  if (!userId) return undefined;

  const env: EnvVars = {
    ...(await loadProviderKeyEnv(userId, provider)),
    ...(await loadGitIdentityEnv(userId)),
    ...prepareAssetsDirEnv(threadId, userId, assetsDir),
  };
  return Object.keys(env).length > 0 ? env : undefined;
}
