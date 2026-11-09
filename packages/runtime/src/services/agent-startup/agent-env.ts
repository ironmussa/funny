import { mkdirSync } from 'node:fs';

import type { AgentProvider } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { isSandboxRunner } from '../sandbox-runner.js';
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

/**
 * Sandbox runners (thread-sandboxes) hold no model credential: Claude agents
 * call Anthropic through the server's LLM proxy with the sandbox's proxy token,
 * and the server adds the owner's real credential. Explicit per provider —
 * the token is scrubbed from every other child environment.
 */
export function llmProxyEnv(
  provider: AgentProvider,
  env: Record<string, string | undefined> = process.env,
): EnvVars {
  const token = env.FUNNY_LLM_PROXY_TOKEN;
  const server = env.TEAM_SERVER_URL;
  if (!token || !server || provider !== 'claude') return {};
  return {
    ANTHROPIC_BASE_URL: `${server.replace(/\/+$/, '')}/api/llm-proxy/anthropic`,
    ANTHROPIC_AUTH_TOKEN: token,
  };
}

/**
 * A sandbox runner is a clean machine: no `gh auth`, no credential helper, and
 * the checkout's remote carries no token (sandbox-checkout strips it). So the
 * agent gets the owner's GitHub token (project override, then the user's PAT)
 * in its environment, plus a git credential helper that reads it from there —
 * `git push` and `gh` work, and nothing is written to disk or `.git/config`.
 * Normal runners keep the user's own git / `gh` login untouched.
 */
export function sandboxGithubEnv(
  token: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): EnvVars {
  if (!token || !isSandboxRunner(env)) return {};
  return {
    GH_TOKEN: token,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0:
      '!f() { test "$1" = get && printf \'username=x-access-token\\npassword=%s\\n\' "$GH_TOKEN"; }; f',
  };
}

async function loadSandboxGithubEnv(userId: string, projectId?: string | null): Promise<EnvVars> {
  if (!isSandboxRunner()) return {};
  const token = await getServices().profile.getGithubToken(userId, projectId || undefined);
  return sandboxGithubEnv(token);
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
/** `$BROWSER` → open URLs in the thread's browser session (see open-url-bridge). */
async function loadBrowserOpenEnv(userId: string, threadId: string): Promise<EnvVars> {
  const { browserOpenEnv } = await import('../browser-automation/open-url-bridge.js');
  return browserOpenEnv(userId, threadId);
}

export async function buildAgentEnv(input: {
  threadId: string;
  userId?: string;
  /** The thread being started; its project picks a project-level GitHub token. */
  thread?: { projectId?: string | null };
  provider: AgentProvider;
  assetsDir?: string;
}): Promise<EnvVars | undefined> {
  const { threadId, userId, thread, provider, assetsDir } = input;
  if (!userId) return undefined;

  const env: EnvVars = {
    ...(await loadProviderKeyEnv(userId, provider)),
    ...llmProxyEnv(provider),
    ...(await loadGitIdentityEnv(userId)),
    ...(await loadSandboxGithubEnv(userId, thread?.projectId)),
    ...prepareAssetsDirEnv(threadId, userId, assetsDir),
    ...(await loadBrowserOpenEnv(userId, threadId)),
  };
  return Object.keys(env).length > 0 ? env : undefined;
}
