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

import type { AgentProvider, PermissionApprovalCapability } from '@funny/shared';
import {
  GATEABLE_ACP_PROVIDER_IDS,
  type GateableAcpProvider,
} from '@funny/shared/provider-manifests';

import { CodexACPProcess } from './codex-acp.js';
import { CodexSDKProcess } from './codex-sdk.js';
import { CursorACPProcess } from './cursor-acp.js';
import { DeepAgentProcess } from './deepagent-process.js';
import { GeminiACPProcess } from './gemini-acp.js';
import type { IAgentProcessFactory, IAgentProcess, AgentProcessOptions } from './interfaces.js';
import { LLMApiProcess } from './llm/llm-api-process.js';
import { OpenCodeACPProcess } from './opencode-acp.js';
import { PiSDKProcess } from './pi-sdk.js';
import { SDKClaudeProcess } from './sdk-claude.js';

export type ProcessConstructor = new (opts: AgentProcessOptions) => IAgentProcess;
function isAcpCliProvider(id: string): id is GateableAcpProvider {
  return id in ACP_BUILTIN_PROCESSES;
}

// Always-on providers: Claude and Codex use SDKs and are never gated; the
// non-ACP bundled backends aren't part of the lean-core ACP toggle.
const ALWAYS_ON_PROVIDERS: ReadonlyArray<readonly [string, ProcessConstructor]> = [
  ['claude', SDKClaudeProcess],
  ['codex', CodexSDKProcess],
  ['deepagent', DeepAgentProcess],
  ['llm-api', LLMApiProcess],
  ['pi', PiSDKProcess],
];

// The gateable ACP built-ins, keyed by id.
const ACP_BUILTIN_PROCESSES: Record<GateableAcpProvider, ProcessConstructor> = {
  gemini: GeminiACPProcess,
  cursor: CursorACPProcess,
  opencode: OpenCodeACPProcess,
};

/**
 * Resolve which ACP CLI built-in providers are active from `FUNNY_PROVIDERS`
 * (comma-separated ids). Unset/empty → all gateable built-ins. Unknown /
 * non-gateable entries are ignored (Claude/Codex are always on regardless).
 * This is the lean-core toggle: "don't register every provider by default."
 */
export function resolveActiveAcpProviders(
  raw: string | undefined = process.env.FUNNY_PROVIDERS,
): GateableAcpProvider[] {
  if (!raw || !raw.trim()) return [...GATEABLE_ACP_PROVIDER_IDS];
  const requested = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return GATEABLE_ACP_PROVIDER_IDS.filter((id) => requested.has(id));
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

export type CodexTransport = 'sdk' | 'acp';

/**
 * Codex ACP is deliberately opt-in while its live approval path rolls out.
 * Fail fast on invalid configuration instead of silently changing transport
 * semantics back to the SDK.
 */
export function resolveCodexTransport(raw = process.env.FUNNY_CODEX_TRANSPORT): CodexTransport {
  if (raw === undefined || raw.trim() === '') return 'sdk';
  if (raw === 'sdk' || raw === 'acp') return raw;
  throw new Error(`Invalid FUNNY_CODEX_TRANSPORT=${JSON.stringify(raw)}. Expected "sdk" or "acp".`);
}

/**
 * Capability advertised by the effective process factory. The runtime sends
 * this with status data so the client never presents an approval control that
 * the selected Codex transport cannot resume.
 */
export function resolvePermissionApprovalCapability(
  provider: AgentProvider,
): PermissionApprovalCapability | undefined {
  if (provider !== 'codex') return undefined;
  return resolveCodexTransport() === 'acp'
    ? { kind: 'structured', transport: 'codex-acp' }
    : { kind: 'unavailable', reason: 'codex-sdk-no-interactive-approval' };
}

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
export function getActiveBuiltinProviders(): GateableAcpProvider[] {
  return GATEABLE_ACP_PROVIDER_IDS.filter((id) => providerRegistry.has(id));
}

/** Enable a gated-off built-in ACP provider live (no restart). False if `id`
 *  is not a known ACP built-in. */
export function enableBuiltinProvider(id: string): boolean {
  if (!isAcpCliProvider(id)) return false;
  registerProvider(id, ACP_BUILTIN_PROCESSES[id]);
  return true;
}

/** Disable a built-in ACP provider live (no restart). Idempotent: returns
 *  false ONLY when `id` is not a known ACP built-in — disabling one that is
 *  already gated off still returns true (the caller's intent is satisfied).
 *  Returning `unregisterProvider`'s "was it present" result here would surface
 *  a spurious 400 in the toggle route when the registry is already in the
 *  requested state (e.g. after a restart restored a lean set). */
export function disableBuiltinProvider(id: string): boolean {
  if (!isAcpCliProvider(id)) return false;
  unregisterProvider(id);
  return true;
}

export const defaultProcessFactory: IAgentProcessFactory = {
  create(opts: AgentProcessOptions): IAgentProcess {
    if (opts.provider === 'codex' && resolveCodexTransport() === 'acp') {
      return new CodexACPProcess(opts);
    }
    const Ctor = providerRegistry.get(opts.provider ?? 'claude') ?? SDKClaudeProcess;
    return new Ctor(opts);
  },
};
