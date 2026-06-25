// ─── Agent Resources ────────────────────────────────────
//
// Provider-scoped model for everything an agent can discover, show, suggest, or
// execute: skills, slash commands, MCP servers, plugins, connectors, built-in
// tools, and template resources. This module is the SINGLE source of truth for
// "which resources apply to provider X" — both the client composer (display)
// and the runtime (injection) consume the same descriptor + helpers so the two
// processes cannot drift. See openspec/changes/agent-resources/design.md.

import type { AgentProvider, KnownProvider } from '../primitives.js';
import type { McpServerType } from './mcp.js';

/** The distinct kinds of agent resource. `skill` and `slash-command` are NOT the same. */
export type AgentResourceKind =
  | 'skill'
  | 'slash-command'
  | 'mcp-server'
  | 'plugin'
  | 'connector'
  | 'builtin-tool'
  | 'template';

/** Where a resource physically comes from — answers "where do I manage this?". */
export type ResourceOrigin =
  | 'claude-global' // ~/.claude/skills + ~/.agents lock file
  | 'claude-project' // {project}/.claude/{skills,commands}
  | 'claude-plugin' // ~/.claude/plugins
  | 'codex-global' // ~/.codex/skills and ~/.agents/skills
  | 'codex-project' // {project}/.codex/skills and {project}/.agents/skills
  | 'mcp-project' // {project}/.mcp.json
  | 'mcp-user' // ~/.claude.json
  | 'deepagent-template'
  | 'provider-session' // reported by the live SDK/ACP session (built-ins + dynamic)
  | 'builtin';

/** A slash command is either provider-shipped (built-in) or user-authored (custom). */
export type CommandTier = 'builtin' | 'custom';

/** Why a resource is not usable by / hidden for the targeted provider+phase. */
export type AgentResourceHiddenReason =
  | 'provider_mismatch'
  | 'unsupported_transport'
  | 'disabled'
  | 'needs_auth';

/** Resolution phase — Settings is inventory; composer/runtime are capability-filtered. */
export type ResourcePhase = 'settings' | 'composer' | 'runtime';

export interface AgentResource {
  kind: AgentResourceKind;
  name: string;
  description?: string;
  origin: ResourceOrigin;
  /**
   * Provider allow-list, or `'all'` for capability-gated shareables (e.g. MCP).
   * Compatibility answers "CAN this provider use it?"; origin answers "where is it?".
   */
  compatibleProviders: AgentProvider[] | 'all';
  /** Whether usable by the provider this resolution targeted. */
  usable: boolean;
  /** Populated when `usable` is false (or the resource is hidden in this phase). */
  hiddenReason?: AgentResourceHiddenReason;
  /** Only for `kind === 'slash-command'`. */
  commandTier?: CommandTier;
  /** Preferred thread mode when this slash command starts a new thread. */
  threadMode?: 'local' | 'worktree';
  scope?: 'global' | 'project';
  sourceUrl?: string;
  installedAt?: string;
  updatedAt?: string;
  /** Only for `kind === 'mcp-server'`. */
  transport?: McpServerType;
}

// ─── Provider resource descriptor ────────────────────────
//
// A declarative, per-provider statement of WHICH resource tiers the provider
// has and WHERE each comes from. `shared` cannot read the filesystem, so skill
// / custom-command sources are opaque string markers the runtime resolver
// interprets (e.g. 'claude-skills' → scan {project}/.claude/skills).

/** Filesystem skill source markers, or `'none'` if the provider has no skill concept. */
export type SkillSource = string[] | 'none';

/** Custom-command source: a filesystem marker, `'session'`, or `'none'`. */
export type CommandSource = string | 'session' | 'none';

export interface ProviderResourceDescriptor {
  /** Filesystem skill source markers, or 'none'. */
  skills: SkillSource;
  /** Built-in commands are ALWAYS sourced from the live provider session. */
  builtinCommands: 'session';
  /** Custom command source. Claude: a filesystem marker; others: 'none' (v1). */
  customCommands: CommandSource;
  /** MCP capability for this provider (capability — policy is per-resource). */
  mcp: { supported: boolean; transports: McpServerType[] };
}

const ALL_TRANSPORTS: McpServerType[] = ['stdio', 'http', 'sse'];

/**
 * Permissive default for unknown / runtime-registered providers: no Claude
 * filesystem skills or commands leak to them, built-ins still come from their
 * session, and MCP stays broadly available (the ACP adapter's capability filter
 * remains the second line of defense).
 */
export const DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR: ProviderResourceDescriptor = {
  skills: 'none',
  builtinCommands: 'session',
  customCommands: 'none',
  mcp: { supported: true, transports: ALL_TRANSPORTS },
};

/**
 * The bundled-provider descriptor map. Claude is the only provider with a
 * filesystem skill/custom-command concept in v1; every other provider gets its
 * built-ins from its session and authors no custom commands yet (declared
 * extension point, not a built feature).
 */
export const PROVIDER_RESOURCE_DESCRIPTORS: Record<KnownProvider, ProviderResourceDescriptor> = {
  claude: {
    skills: ['claude-global', 'claude-project', 'claude-plugin'],
    builtinCommands: 'session',
    customCommands: 'claude-commands',
    mcp: { supported: true, transports: ALL_TRANSPORTS },
  },
  codex: {
    // Codex ships skills under ~/.codex/skills (incl. a `.system/` set), reads
    // agent-standard skills from ~/.agents/skills, and reads project skills from
    // {project}/.codex/skills plus {project}/.agents/skills. Custom commands
    // still come from the live session (no filesystem custom-command location in v1).
    skills: ['codex-global', 'codex-project'],
    builtinCommands: 'session',
    customCommands: 'none',
    mcp: { supported: true, transports: ALL_TRANSPORTS },
  },
  gemini: { ...DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR },
  pi: { ...DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR },
  cursor: { ...DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR },
  opencode: { ...DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR },
  deepagent: {
    skills: ['deepagent-template'],
    builtinCommands: 'session',
    customCommands: 'none',
    mcp: { supported: true, transports: ALL_TRANSPORTS },
  },
  'llm-api': {
    skills: 'none',
    builtinCommands: 'session',
    customCommands: 'none',
    mcp: { supported: false, transports: [] },
  },
  external: { ...DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR },
};

/** Resolve the resource descriptor for any provider id (falls back to the permissive default). */
export function getProviderResourceDescriptor(provider: AgentProvider): ProviderResourceDescriptor {
  return (
    PROVIDER_RESOURCE_DESCRIPTORS[provider as KnownProvider] ?? DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR
  );
}

/** Whether a resource's compatibility allow-list admits `provider`. */
export function resourceUsableByProvider(
  resource: Pick<AgentResource, 'compatibleProviders'>,
  provider: AgentProvider,
): boolean {
  return resource.compatibleProviders === 'all' || resource.compatibleProviders.includes(provider);
}

// ─── Resolver contract ───────────────────────────────────

export interface ResolveAgentResourcesInput {
  projectPath?: string;
  projectId?: string;
  provider: AgentProvider;
  model?: string;
  threadId?: string;
  phase: ResourcePhase;
  /** Claude profile config directory resolved from the selected project profile. */
  claudeConfigDir?: string;
  /**
   * Session-reported slash command names (no leading slash), if the thread has
   * an active session. Authoritative source for built-in / dynamic commands.
   */
  sessionCommands?: string[];
}

export interface AgentResourcesResult {
  provider: AgentProvider;
  model?: string;
  /** Resources surfaced for this phase. `settings` includes incompatible ones for audit. */
  resources: AgentResource[];
  /** Incompatible / hidden resources, each carrying a `hiddenReason`. */
  hidden: AgentResource[];
}
