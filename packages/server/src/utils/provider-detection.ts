/**
 * Auto-detection of available agent providers at startup.
 * Checks for CLI binaries and SDKs for each provider.
 */

import type { AgentProvider } from '@funny/shared';
import { checkClaudeBinaryAvailability, validateClaudeBinary } from './claude-binary.js';
import { log } from '../lib/abbacchio.js';

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
    try { cliVersion = validateClaudeBinary(cliResult.path); } catch {}
  }

  return {
    available: sdkAvailable,
    sdkAvailable,
    cliAvailable: cliResult.available,
    cliPath: cliResult.path,
    cliVersion,
    error: !sdkAvailable ? 'Claude Agent SDK not found. Run: npm install @anthropic-ai/claude-agent-sdk' : undefined,
  };
}

/** Check if the Codex SDK can be loaded (dynamic import). */
async function checkCodexSDK(): Promise<boolean> {
  try {
    await import('@openai/codex-sdk');
    return true;
  } catch {
    return false;
  }
}

/** Check if the codex CLI is available in PATH. */
function checkCodexCLI(): { available: boolean; path?: string } {
  try {
    const { execSync } = require('child_process');
    const cmd = process.platform === 'win32' ? 'where codex' : 'which codex';
    const result = execSync(cmd, { timeout: 5000, encoding: 'utf-8' });
    const path = result.trim().split('\n')[0]?.trim();
    if (path) return { available: true, path };
  } catch {}
  return { available: false };
}

/** Check full Codex availability (SDK + optional CLI). */
async function checkCodexAvailability(): Promise<ProviderAvailability> {
  const sdkAvailable = await checkCodexSDK();
  const cli = checkCodexCLI();

  return {
    available: sdkAvailable,
    sdkAvailable,
    cliAvailable: cli.available,
    cliPath: cli.path,
    error: !sdkAvailable ? 'Codex SDK not found. Run: npm install @openai/codex-sdk' : undefined,
  };
}

/**
 * Get all available providers. Results are cached after first call.
 * Call resetProviderCache() to force re-detection.
 */
export async function getAvailableProviders(): Promise<Map<AgentProvider, ProviderAvailability>> {
  if (cachedProviders) return cachedProviders;

  const [claude, codex] = await Promise.all([
    checkClaudeAvailability(),
    checkCodexAvailability(),
  ]);

  cachedProviders = new Map<AgentProvider, ProviderAvailability>();
  cachedProviders.set('claude', claude);
  cachedProviders.set('codex', codex);

  return cachedProviders;
}

/** Reset the cached provider detection results. */
export function resetProviderCache(): void {
  cachedProviders = null;
}

/** Log detected providers to console. */
export async function logProviderStatus(): Promise<void> {
  const providers = await getAvailableProviders();
  for (const [name, info] of providers) {
    if (info.available) {
      log.info(`Provider ${name}: available`, { namespace: 'server', provider: name, cliPath: info.cliPath, cliVersion: info.cliVersion });
    } else {
      log.info(`Provider ${name}: not available`, { namespace: 'server', provider: name, error: info.error ?? 'unknown error' });
    }
  }
}
