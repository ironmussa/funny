/**
 * Default multi-provider process factory.
 *
 * Uses a registry map to route to the correct process class based on `opts.provider`.
 * Reusable by both the server (AgentRunner) and the pipeline service.
 *
 * To add a new provider:
 *   1. Create a class implementing IAgentProcess
 *   2. Call `registerProvider('name', MyProcess)` before creating agents
 */

import { KNOWN_ACP_PROVIDER_IDS, type KnownAcpProvider } from '@funny/shared/provider-manifests';

import { CodexACPProcess } from './codex-acp.js';
import { CursorACPProcess } from './cursor-acp.js';
import { DeepAgentProcess } from './deepagent-process.js';
import { GeminiACPProcess } from './gemini-acp.js';
import type { IAgentProcessFactory, IAgentProcess, AgentProcessOptions } from './interfaces.js';
import { LLMApiProcess } from './llm/llm-api-process.js';
import { OpenCodeACPProcess } from './opencode-acp.js';
import { PiSDKProcess } from './pi-sdk.js';
import { SDKClaudeProcess } from './sdk-claude.js';

export type ProcessConstructor = new (opts: AgentProcessOptions) => IAgentProcess;

// Always-on providers: Claude (SDK) is the default and never gated; the non-ACP
// bundled backends (DeepAgent, llm-api) aren't part of the lean-core ACP toggle.
const ALWAYS_ON_PROVIDERS: ReadonlyArray<readonly [string, ProcessConstructor]> = [
  ['claude', SDKClaudeProcess],
  ['deepagent', DeepAgentProcess],
  ['llm-api', LLMApiProcess],
  ['pi', PiSDKProcess],
];

// The gateable ACP built-ins, keyed by id.
const ACP_BUILTIN_PROCESSES: Record<KnownAcpProvider, ProcessConstructor> = {
  codex: CodexACPProcess,
  gemini: GeminiACPProcess,
  cursor: CursorACPProcess,
  opencode: OpenCodeACPProcess,
};

/**
 * Resolve which ACP built-in providers are active from `FUNNY_PROVIDERS`
 * (comma-separated ids). Unset/empty → all bundled (no regression). Unknown /
 * non-ACP entries are ignored (Claude is always on regardless). This is the
 * lean-core toggle: "don't register every provider by default."
 */
export function resolveActiveAcpProviders(
  raw: string | undefined = process.env.FUNNY_PROVIDERS,
): KnownAcpProvider[] {
  if (!raw || !raw.trim()) return [...KNOWN_ACP_PROVIDER_IDS];
  const requested = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return KNOWN_ACP_PROVIDER_IDS.filter((id) => requested.has(id));
}

/** Build the initial registry: always-on providers + the active ACP built-ins. */
function buildProviderRegistry(): Map<string, ProcessConstructor> {
  const registry = new Map<string, ProcessConstructor>(ALWAYS_ON_PROVIDERS);
  for (const id of resolveActiveAcpProviders()) {
    registry.set(id, ACP_BUILTIN_PROCESSES[id]);
  }
  return registry;
}

const providerRegistry = buildProviderRegistry();

/** Register a new provider process class at runtime. */
export function registerProvider(name: string, ctor: ProcessConstructor): void {
  providerRegistry.set(name, ctor);
}

/** Remove a runtime-registered provider. Returns true if it was registered. */
export function unregisterProvider(name: string): boolean {
  return providerRegistry.delete(name);
}

/** The ACP built-in providers currently active (registered). Drives the
 *  advertisement so the client picker can hide gated-off built-ins (lean-core). */
export function getActiveBuiltinProviders(): KnownAcpProvider[] {
  return KNOWN_ACP_PROVIDER_IDS.filter((id) => providerRegistry.has(id));
}

/** Enable a gated-off built-in ACP provider live (no restart). False if `id`
 *  is not a known ACP built-in. */
export function enableBuiltinProvider(id: string): boolean {
  if (!(id in ACP_BUILTIN_PROCESSES)) return false;
  registerProvider(id, ACP_BUILTIN_PROCESSES[id as KnownAcpProvider]);
  return true;
}

/** Disable a built-in ACP provider live (no restart). Idempotent: returns
 *  false ONLY when `id` is not a known ACP built-in — disabling one that is
 *  already gated off still returns true (the caller's intent is satisfied).
 *  Returning `unregisterProvider`'s "was it present" result here would surface
 *  a spurious 400 in the toggle route when the registry is already in the
 *  requested state (e.g. after a restart restored a lean set). */
export function disableBuiltinProvider(id: string): boolean {
  if (!(id in ACP_BUILTIN_PROCESSES)) return false;
  unregisterProvider(id);
  return true;
}

export const defaultProcessFactory: IAgentProcessFactory = {
  create(opts: AgentProcessOptions): IAgentProcess {
    const Ctor = providerRegistry.get(opts.provider ?? 'claude') ?? SDKClaudeProcess;
    return new Ctor(opts);
  },
};
