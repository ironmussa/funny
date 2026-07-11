/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 */

/**
 * Auto-detection of available agent providers at startup.
 * Checks for CLI binaries and SDKs for each provider.
 */

import { accessSync, constants as fsConstants, existsSync } from 'fs';
import { delimiter as pathDelimiter, join as pathJoin } from 'path';

import type { AgentProvider } from '@funny/shared';
import { resolveSpawnCommand, type SpawnConfig } from '@funny/shared/provider-manifest';

import { log } from '../lib/logger.js';
import { checkClaudeBinaryAvailability, validateClaudeBinary } from './claude-binary.js';

export interface ProviderAvailability {
  available: boolean;
  sdkAvailable: boolean;
  cliAvailable: boolean;
  cliPath?: string;
  cliVersion?: string;
  error?: string;
}

let cachedProviders: Map<AgentProvider, ProviderAvailability> | null = null;

/** Check if the Claude Agent SDK can be loaded. */
async function checkClaudeSDK(): Promise<boolean> {
  try {
    await import('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

/** Check full Claude availability (SDK + optional CLI). */
async function checkClaudeAvailability(): Promise<ProviderAvailability> {
  const sdkAvailable = await checkClaudeSDK();
  const cliResult = checkClaudeBinaryAvailability();

  let cliVersion: string | undefined;
  if (cliResult.available && cliResult.path) {
    try {
      cliVersion = validateClaudeBinary(cliResult.path);
    } catch {}
  }

  return {
    available: sdkAvailable,
    sdkAvailable,
    cliAvailable: cliResult.available,
    cliPath: cliResult.path,
    cliVersion,
    error: !sdkAvailable
      ? 'Claude Agent SDK not found. Run: npm install @anthropic-ai/claude-agent-sdk'
      : undefined,
  };
}

/** Check if the Codex SDK can be loaded. */
async function checkCodexSDK(): Promise<boolean> {
  try {
    await import('@openai/codex-sdk');
    return true;
  } catch {
    return false;
  }
}

/**
 * Codex runs through the official SDK. The SDK owns CLI resolution, including
 * a CODEX_BINARY_PATH/CODEX_BIN override when provided to the process adapter.
 */
async function checkCodexAvailability(): Promise<ProviderAvailability> {
  const sdkAvailable = await checkCodexSDK();
  return {
    available: sdkAvailable,
    sdkAvailable,
    cliAvailable: sdkAvailable,
    cliPath: process.env.CODEX_BINARY_PATH ?? process.env.CODEX_BIN,
    error: !sdkAvailable ? 'Codex SDK not found. Run: bun add @openai/codex-sdk' : undefined,
  };
}

/**
 * Get all available providers. Results are cached after first call.
 * Call resetProviderCache() to force re-detection.
 */
export async function getAvailableProviders(): Promise<Map<AgentProvider, ProviderAvailability>> {
  if (cachedProviders) return cachedProviders;

  const [claude, codex] = await Promise.all([checkClaudeAvailability(), checkCodexAvailability()]);

  cachedProviders = new Map<AgentProvider, ProviderAvailability>();
  cachedProviders.set('claude', claude);
  cachedProviders.set('codex', codex);

  return cachedProviders;
}

/** Reset the cached provider detection results. */
export function resetProviderCache(): void {
  cachedProviders = null;
  pathResolveCache.clear();
}

// ── Manifest-driven availability (model-picker-availability §1) ──────────────
// Whether each ACTIVE provider can actually run on this runner, derived
// generically from its manifest's resolved spawn command (env override → npx →
// binary, via resolveSpawnCommand) being resolvable on PATH. This is the single
// availability signal the client picker gates on; claude is special-cased (it
// has no ACP manifest), and the non-ACP bundled backends are available in v1.

const pathResolveCache = new Map<string, boolean>();

/** Does `command` resolve to an executable on PATH (or as a direct path)?
 *  Shell-free (no subprocess) to avoid any injection from manifest-supplied
 *  commands. Cached per command; cleared by resetProviderCache. */
function commandOnPath(command: string): boolean {
  const cached = pathResolveCache.get(command);
  if (cached !== undefined) return cached;
  const win = process.platform === 'win32';
  const exts = win ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const hasSep = command.includes('/') || (win && command.includes('\\'));
  const bases = hasSep
    ? [command]
    : (process.env.PATH ?? '')
        .split(pathDelimiter)
        .filter(Boolean)
        .map((dir) => pathJoin(dir, command));
  const executable = (p: string): boolean => {
    try {
      if (win) return existsSync(p);
      accessSync(p, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const ok = bases.some((base) => exts.some((ext) => executable(base + ext)));
  pathResolveCache.set(command, ok);
  return ok;
}

/** An active ACP provider (built-in or external) with the spawn config needed
 *  to decide availability. The caller (which has manifest access via
 *  `@funny/core/agents`) supplies these — keeps this module free of the heavy
 *  agents barrel. */
export interface ProviderSpawnRef {
  id: string;
  spawn: SpawnConfig;
}

/**
 * The active providers that can actually run on this runner. Manifest-driven:
 * - claude → existing SDK/CLI detection (no ACP manifest);
 * - each supplied ACP provider → its RESOLVED spawn command (env/npx precedence
 *   via resolveSpawnCommand) on PATH;
 * - pi / deepagent / llm-api → available in v1 (SDK/key/config-based, not gated here).
 *
 * `deps` is injectable for tests (no real PATH probing / env).
 */
export async function resolveProviderAvailability(
  acpProviders: ProviderSpawnRef[],
  deps: {
    commandExists?: (cmd: string) => boolean;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<string[]> {
  const commandExists = deps.commandExists ?? commandOnPath;
  const env = deps.env ?? process.env;
  const available: string[] = [];

  // claude — always-on, special-cased
  const detected = await getAvailableProviders();
  if (detected.get('claude')?.available) available.push('claude');
  if (detected.get('codex')?.available) available.push('codex');

  // non-ACP bundled backends — available in v1 (not gated by a CLI on PATH)
  available.push('pi', 'deepagent', 'llm-api');

  // active ACP providers (built-in + external) — resolved spawn command on PATH
  for (const p of acpProviders) {
    if (commandExists(resolveSpawnCommand(p.spawn, env).command)) available.push(p.id);
  }

  return available;
}

/** Log detected providers to console. */
export async function logProviderStatus(): Promise<void> {
  const providers = await getAvailableProviders();
  for (const [name, info] of providers) {
    if (info.available) {
      log.info(`Provider ${name}: available`, {
        namespace: 'server',
        provider: name,
        cliPath: info.cliPath,
        cliVersion: info.cliVersion,
      });
    } else {
      log.info(`Provider ${name}: not available`, {
        namespace: 'server',
        provider: name,
        error: info.error ?? 'unknown error',
      });
    }
  }
}
