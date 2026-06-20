/**
 * Provider manifest contract — the declarative description of an ACP-based
 * agent provider.
 *
 * A `ProviderManifest` is PURE DATA: it carries everything the generic ACP
 * runtime (`GenericACPProcess`) needs to spawn the CLI, open an ACP session,
 * select a model, set the permission mode, fork sessions, and translate the
 * agent's `sessionUpdate` stream into funny's message stream — WITHOUT a
 * bespoke per-provider process class.
 *
 * The genuinely provider-specific translateUpdate divergences are expressed
 * as named {@link QuirkFlags} + menu selectors whose behaviors are implemented
 * in core. A manifest SELECTS from that fixed in-core menu; it never carries
 * executable code. This is the crux that makes a future external (Phase B)
 * manifest loader safe: the worst an external JSON manifest can do is point
 * funny at a binary already on the runner's PATH — it cannot define new logic.
 *
 * Imports here are from leaf contract modules so `models.ts` can derive its
 * registry from the manifest set without coupling the manifest contract back
 * to the model registry.
 */

import type { PermissionMode } from './primitives.js';
import type { AttachmentLimits, ModelDefinition, ProviderKeyConfig } from './provider-types.js';

// ─── Quirk flags (the complete minimal set — see Phase 0 audit) ──────────────

/**
 * Named, boolean/enum selectors for the small `translateUpdate` divergences
 * between providers. Each flag's BEHAVIOR lives in core (`agents/quirks/`); the
 * manifest only toggles it. A provider needing a behavior outside this menu is
 * a reviewed core change that extends the menu — never a manifest-only edit.
 *
 * `thought → Think` is intentionally absent: it is universal across all five
 * adapters, so it is base behavior, not a quirk.
 */
export interface QuirkFlags {
  /** Buffer the agent's "preamble" tool_calls into a Think card. (codex, gemini) */
  bufferPreambleAsThink?: boolean;
  /** How a plan/todo update renders: inline text vs a TodoWrite card. */
  planRender?: 'text' | 'todoCard';
  /** Defer tool calls whose input isn't renderable yet until a later update. (cursor, opencode) */
  deferUnrenderableToolInput?: boolean;
  /** Synthesize a tool_use from an orphan tool-call update with no prior start. (gemini, cursor, opencode) */
  synthToolUseFromOrphanUpdate?: boolean;
  /**
   * Strip a provider banner from the FIRST agent message. The value is a
   * regex source string (DATA, applied in core). (pi)
   *
   * NOTE (Phase B): an externally-supplied regex is a ReDoS vector — validate
   * + timeout before honoring this from an untrusted manifest. Built-in
   * regexes are trusted.
   */
  stripFirstMessageBanner?: string;
  /**
   * Permission gating model. `gated` = rules → permission card → pause for the
   * user. `auto-allow` = approve every tool call without gating. (pi = auto-allow) */
  permissionModel?: 'gated' | 'auto-allow';
  /** Drop MCP servers the agent didn't advertise capability for (http/sse). (pi, cursor, opencode) */
  filterMcpByCapability?: boolean;
  /**
   * Repair "glued" agent-message chunks. Some agents (codex) emit several
   * distinct status messages within one turn as separate `agent_message_chunk`
   * events with no tool call between them; the accumulator concatenates them
   * with no separator, producing run-ons like `…render.Aviso…`. When set, a
   * `\n\n` is inserted at the junction ONLY when the accumulated text ends with
   * terminal punctuation AND the incoming chunk starts with an uppercase letter
   * with no whitespace at the boundary — the exact signature of a dropped
   * separator. Real token streaming keeps the model's own spacing, so this
   * never splits a single streamed message. (codex) */
  splitGluedAgentMessages?: boolean;
}

// ─── Menu selectors (closed enums in core, not free-form) ────────────────────

/** How the model is selected: a runtime ACP method vs a CLI launch arg. */
export type ModelVia = 'acp-method' | 'cli-arg';
/** How the permission/session mode is applied: an ACP method, a CLI flag, or not at all. */
export type ModeVia = 'acp-setSessionMode' | 'cli-flag' | 'none';
/** Named pre-launch side effect implemented in core. The ONLY imperative selector. */
export type Prelaunch = 'gemini-trust-folder';

/** The ACP method used to set the session model after `session/new`. */
export interface SetModelConfig {
  /**
   * `unstable_setSessionModel` — the SDK's typed method (codex, pi, cursor).
   * `session/set_model` — a raw ACP method invoked via the SDK `extMethod`
   *   escape hatch for agents that implement it without advertising the
   *   capability (opencode).
   */
  method: 'unstable_setSessionModel' | 'session/set_model';
}

// ─── Spawn configuration ─────────────────────────────────────────────────────

/**
 * How to launch the provider's ACP CLI over stdio. Resolution order
 * (see {@link resolveSpawnCommand}):
 *   1. first set env var in `binEnvVars` → that path, with `args`
 *   2. `npxSpec` present AND its `useEnvVar` === '1' → `npx` + `npxSpec.pkg`
 *   3. default `command` + `args`
 */
export interface SpawnConfig {
  /** Default executable when no override env var is set. */
  command: string;
  /** Args appended after the executable (also used with a `binEnvVars` override). */
  args: string[];
  /** Env vars (in priority order) whose value, if set, overrides `command`. */
  binEnvVars: string[];
  /** Optional `npx` fallback gated behind an env var (e.g. CI without a global install). */
  npxSpec?: { useEnvVar: string; pkg: string[] };
}

// ─── Model strategy ──────────────────────────────────────────────────────────

/**
 * Static: the manifest carries the full catalog (codex, gemini).
 * Dynamic: the catalog is discovered at runtime from the ACP `session/new`
 *   `models.availableModels` response; the static registry only holds a
 *   `default` sentinel (pi, cursor, opencode).
 */
export type ModelStrategy =
  | { kind: 'static'; entries: Record<string, ModelDefinition>; defaultModel: string }
  | { kind: 'dynamic'; sentinel: ModelDefinition; defaultModel: string };

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * `runner-preauth` — the operator logs the CLI in once on the runner (pi,
 *   opencode via `opencode login`).
 * `provider-key` — funny injects a per-user API key env var at spawn; the
 *   `providerKeyId` matches an entry in `PROVIDER_KEY_REGISTRY`. (codex →
 *   openai, gemini → gemini, cursor → cursor).
 */
export interface AuthConfig {
  mode: 'runner-preauth' | 'provider-key';
  providerKeyId?: ProviderKeyConfig['id'];
}

// ─── The manifest ────────────────────────────────────────────────────────────

export interface ProviderManifest {
  /** Stable provider id, e.g. 'opencode'. Used everywhere a provider is keyed. */
  id: string;
  /** Human-readable label for the picker / settings UI. */
  label: string;
  /** v1 covers ACP. `sdk` / `llm-api` providers stay bespoke for now. */
  kind: 'acp';

  spawn: SpawnConfig;
  models: ModelStrategy;

  /** Omit when the provider selects its model via a CLI arg (gemini) or not at all. */
  setModel?: SetModelConfig;
  /** Where the model comes from. Default 'acp-method' when `setModel` is set. */
  modelVia: ModelVia;

  /** How the session/permission mode is applied. */
  modeVia: ModeVia;
  /**
   * funny PermissionMode → provider-native session mode id, for
   * `modeVia: 'acp-setSessionMode'`. `null` = leave the agent's default.
   * Ignored for `cli-flag` / `none`.
   */
  modeMap: Record<PermissionMode, string | null>;

  /** Capability paths (under `agentCapabilities`) that advertise native session fork. */
  forkCapabilityPaths: string[];

  /** Approximate built-in tool names, surfaced via system:init for the UI only. */
  builtinTools: string[];

  /** Per-provider attachment size ceilings. */
  attachmentLimits: AttachmentLimits;

  auth: AuthConfig;

  /** Named pre-launch side effect (the only imperative selector). */
  prelaunch?: Prelaunch;

  quirks: QuirkFlags;
}

// ─── Spawn resolver ──────────────────────────────────────────────────────────

/**
 * Resolve a manifest's {@link SpawnConfig} against the current environment into
 * a concrete `{ command, args }`. Reproduces the per-provider logic that lived
 * in `acp-fork.ts`'s `resolveAcpCommand` switch.
 */
export function resolveSpawnCommand(
  spawn: SpawnConfig,
  env: Record<string, string | undefined> = process.env,
): { command: string; args: string[] } {
  for (const name of spawn.binEnvVars) {
    const override = env[name];
    if (override) return { command: override, args: spawn.args };
  }
  if (spawn.npxSpec && env[spawn.npxSpec.useEnvVar] === '1') {
    return { command: 'npx', args: spawn.npxSpec.pkg };
  }
  return { command: spawn.command, args: spawn.args };
}
