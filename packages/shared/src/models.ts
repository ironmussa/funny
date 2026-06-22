/**
 * Centralized model registry for all agent providers.
 *
 * Single source of truth: `MODEL_REGISTRY` drives model IDs, labels,
 * context windows, i18n keys, and the TypeScript unions below. Zod
 * schemas (runtime) and the client's provider catalog derive from
 * this file too — do not duplicate model lists elsewhere.
 */

import type { AgentProvider, FollowUpMode, PermissionMode, ThreadMode } from './primitives.js';
// ACP provider catalogs + manifests are the single source of truth for every
// ACP provider's models, labels, defaults, and attachment limits. This file
// composes them with the non-ACP (Claude SDK, DeepAgent) catalogs below.
// The back-import from provider-manifests.ts to this module is type-only, so
// there is no runtime import cycle.
import {
  ACP_MANIFESTS,
  codexModels,
  cursorModels,
  geminiModels,
  opencodeModels,
  piModels,
} from './provider-manifests.js';
import type { AttachmentLimits, ModelDefinition, ProviderKeyConfig } from './provider-types.js';

export type { AttachmentLimits, ModelDefinition, ProviderKeyConfig } from './provider-types.js';

// ── Application defaults ────────────────────────────────────────
// Change these values to update defaults across the entire codebase.

export const DEFAULT_PROVIDER: AgentProvider = 'claude';
export const DEFAULT_THREAD_MODE: ThreadMode = 'local';
export const DEFAULT_FOLLOW_UP_MODE: FollowUpMode = 'queue';
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'autoEdit';

// ── Model registry (single source of truth) ────────────────────

/**
 * Attachment size limits used by the prompt input. Numbers reflect the
 * upstream API ceilings (request payload limit, inline-data cap) and a
 * tiered strategy:
 *
 *   - `inlineMaxBytes`   → embed file contents directly in the prompt
 *                          (single turn cost in tokens; cheap UX-wise).
 *   - `uploadMaxBytes`   → write to runner disk so the agent reads on
 *                          demand with the Read tool (lazy, paginated).
 *                          Above `inlineMaxBytes`, below `hardMaxBytes`.
 *   - `hardMaxBytes`     → reject; file does not fit in a single request
 *                          payload to the provider.
 *
 * Per-provider defaults reflect the smallest provider in the family. A
 * specific model can tighten or relax via `ModelDefinition.attachmentLimits`.
 */
const claudeModels = {
  haiku: {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    contextWindow: 200_000,
    i18nKey: 'haiku',
  },
  sonnet: {
    id: 'claude-sonnet-4-5-20250929',
    label: 'Sonnet 4.5',
    contextWindow: 200_000,
    i18nKey: 'sonnet',
  },
  'sonnet-4.6': {
    id: 'claude-sonnet-4-6[1m]',
    label: 'Sonnet 4.6',
    contextWindow: 1_000_000,
    i18nKey: 'sonnet46',
  },
  opus: {
    id: 'claude-opus-4-6[1m]',
    label: 'Opus 4.6',
    contextWindow: 1_000_000,
    i18nKey: 'opus',
  },
  'opus-4.7': {
    id: 'claude-opus-4-7[1m]',
    label: 'Opus 4.7',
    contextWindow: 1_000_000,
    i18nKey: 'opus47',
  },
  'opus-4.8': {
    id: 'claude-opus-4-8[1m]',
    label: 'Opus 4.8',
    contextWindow: 1_000_000,
    i18nKey: 'opus48',
  },
  'fable-5': {
    id: 'claude-fable-5[1m]',
    label: 'Fable 5',
    contextWindow: 1_000_000,
    i18nKey: 'fable5',
  },
} as const satisfies Record<string, ModelDefinition>;

// codex + gemini static catalogs are owned by their manifests (imported above).

const deepagentModels = {
  'minimax-m2.7': {
    id: 'openai:MiniMax-M2.7',
    label: 'MiniMax M2.7',
    contextWindow: 204_800,
    i18nKey: 'minimaxM27',
  },
  'minimax-m2.7-highspeed': {
    id: 'openai:MiniMax-M2.7-highspeed',
    label: 'MiniMax M2.7 Highspeed',
    contextWindow: 204_800,
    i18nKey: 'minimaxM27Highspeed',
  },
  'deepagent-gpt-4o': {
    id: 'gpt-4o',
    label: 'GPT-4o',
    contextWindow: 128_000,
    i18nKey: 'deepagentGpt4o',
  },
  'deepagent-sonnet': {
    id: 'claude-sonnet-4-5-20250929',
    label: 'Sonnet 4.5',
    contextWindow: 200_000,
    i18nKey: 'deepagentSonnet',
  },
  'deepagent-gemini-2.5-flash': {
    id: 'google-genai:gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    contextWindow: 1_048_576,
    i18nKey: 'deepagentGemini25flash',
  },
  'deepagent-gemini-2.5-pro': {
    id: 'google-genai:gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    contextWindow: 1_048_576,
    i18nKey: 'deepagentGemini25pro',
  },
  'deepagent-gemini-3-flash': {
    id: 'google-genai:gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    contextWindow: 1_000_000,
    i18nKey: 'deepagentGemini3flash',
  },
  'deepagent-gemini-3-pro': {
    id: 'google-genai:gemini-3-pro-preview',
    label: 'Gemini 3 Pro',
    contextWindow: 1_000_000,
    i18nKey: 'deepagentGemini3pro',
  },
  'deepagent-grok-3': {
    id: 'openai:grok-3',
    label: 'Grok 3',
    contextWindow: 131_072,
    i18nKey: 'deepagentGrok3',
  },
  'deepagent-grok-3-mini': {
    id: 'openai:grok-3-mini',
    label: 'Grok 3 Mini',
    contextWindow: 131_072,
    i18nKey: 'deepagentGrok3mini',
  },
  'deepagent-glm-5.1': {
    id: 'openai:glm-5.1',
    label: 'GLM-5.1',
    contextWindow: 128_000,
    i18nKey: 'deepagentGlm51',
  },
  'deepagent-glm-5-turbo': {
    id: 'openai:glm-5-turbo',
    label: 'GLM-5 Turbo',
    contextWindow: 128_000,
    i18nKey: 'deepagentGlm5turbo',
  },
  'deepagent-glm-5v-turbo': {
    id: 'openai:glm-5v-turbo',
    label: 'GLM-5V Turbo',
    contextWindow: 128_000,
    i18nKey: 'deepagentGlm5vturbo',
  },
} as const satisfies Record<string, ModelDefinition>;

// pi / cursor / opencode dynamic sentinel catalogs are owned by their manifests
// (imported above). Real model IDs are discovered at runtime via
// `/system/:provider/models` and passed through `resolveModelId` as wire-format
// strings that each agent's set-model method accepts.

export const MODEL_REGISTRY = {
  claude: claudeModels,
  codex: codexModels,
  gemini: geminiModels,
  pi: piModels,
  cursor: cursorModels,
  opencode: opencodeModels,
  deepagent: deepagentModels,
} as const;

// ── Derived model type unions ─────────────────────────────────

export type ClaudeModel = keyof typeof claudeModels;
export type CodexModel = keyof typeof codexModels;
export type GeminiModel = keyof typeof geminiModels;
export type PiModel = keyof typeof piModels;
export type CursorModel = keyof typeof cursorModels;
export type OpenCodeModel = keyof typeof opencodeModels;
export type DeepAgentModel = keyof typeof deepagentModels;
export type AgentModel =
  | ClaudeModel
  | CodexModel
  | GeminiModel
  | PiModel
  | CursorModel
  | OpenCodeModel
  | DeepAgentModel;

// Helper: narrow a provider string to keys of its sub-registry.
type ModelsOf<P extends keyof typeof MODEL_REGISTRY> = keyof (typeof MODEL_REGISTRY)[P];

export const DEFAULT_MODEL: AgentModel = 'opus-4.8';

// ── Per-provider defaults ─────────────────────────────────────

// ACP defaults derive from each manifest's `models.defaultModel`; non-ACP
// providers (Claude SDK, DeepAgent) are listed explicitly.
const PROVIDER_DEFAULT_MODEL: Record<string, AgentModel> = {
  claude: DEFAULT_MODEL,
  deepagent: 'minimax-m2.7',
  pi: 'default',
  ...Object.fromEntries(
    Object.values(ACP_MANIFESTS).map((m) => [m.id, m.models.defaultModel as AgentModel]),
  ),
};

// ── Per-provider attachment limits ────────────────────────────
// Values track upstream API ceilings: Anthropic accepts ~32 MB per request,
// Gemini caps inline data at ~20 MB before requiring the Files API, OpenAI
// (Codex) accepts ~25 MB. We keep `inlineMaxBytes` low (100 KB) across the
// board so the prompt stays cheap per turn — larger files should go through
// the upload path so the agent reads them on demand with the Read tool.

const KB = 1024;
const MB = 1024 * 1024;

// codex / gemini / cursor / opencode ceilings come from their manifests.
// Non-ACP providers route through multiple upstream providers — use the
// smallest common ceiling so we never exceed the weakest backend.
const PROVIDER_ATTACHMENT_LIMITS: Record<string, AttachmentLimits> = {
  claude: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 25 * MB, hardMaxBytes: 30 * MB },
  deepagent: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  pi: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  'llm-api': { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  external: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  ...Object.fromEntries(Object.values(ACP_MANIFESTS).map((m) => [m.id, m.attachmentLimits])),
};

// ── Provider labels ──────────────────────────────────────────

export interface ModelInfo {
  value: AgentModel;
  label: string;
}

// codex / gemini / cursor / opencode labels come from their manifests.
export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  deepagent: 'Deep Agent',
  pi: 'Pi',
  ...Object.fromEntries(Object.values(ACP_MANIFESTS).map((m) => [m.id, m.label])),
};

/**
 * Every provider id funny knows at compile time: the non-ACP bespoke providers
 * (Claude SDK, DeepAgent, llm-api, external) plus every bundled ACP manifest id.
 * Validation and discovery accept this set; unbundled (future Phase B) provider
 * ids fall through the runtime provider registry rather than a hardcoded union.
 */
export const KNOWN_PROVIDER_IDS: string[] = [
  'claude',
  'deepagent',
  'llm-api',
  'external',
  'pi',
  ...Object.keys(ACP_MANIFESTS),
];

// ── Permission mode mapping (Claude SDK specific) ─────────────
// See PermissionMode in shared/primitives.ts for the canonical mapping table
// and the naming-trap note (funny.autoEdit ≠ claude.acceptEdits).
// `autoEdit` deliberately maps to `bypassPermissions`, not `acceptEdits`.

const CLAUDE_PERMISSION_MAP: Record<PermissionMode, string> = {
  plan: 'plan',
  auto: 'auto',
  autoEdit: 'bypassPermissions',
  confirmEdit: 'default',
  ask: 'default',
};

// ── Ask-mode tools (read-only) ───────────────────────────────

const CLAUDE_ASK_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

// ── Default tools per provider ────────────────────────────────

const CLAUDE_DEFAULT_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
  'NotebookEdit',
];

const CODEX_DEFAULT_TOOLS: string[] = [];

// Gemini manages its own tools via ACP — no default tool list needed
const GEMINI_DEFAULT_TOOLS: string[] = [];

// Pi manages its own tools via ACP — no default tool list needed
const PI_DEFAULT_TOOLS: string[] = [];

// Cursor manages its own tools via ACP — no default tool list needed
const CURSOR_DEFAULT_TOOLS: string[] = [];

// opencode manages its own tools via ACP — no default tool list needed
const OPENCODE_DEFAULT_TOOLS: string[] = [];

// Deep Agent manages its own tools via LangGraph — no default tool list needed
const DEEPAGENT_DEFAULT_TOOLS: string[] = [];

// LLM API manages its own tools via ToolRunner — no default tool list needed
const LLM_API_DEFAULT_TOOLS = ['bash', 'read', 'edit', 'glob', 'grep'];

// ── Provider Key Registry ────────────────────────────────────
// Central registry of per-user API keys. Adding a new provider here
// automatically enables it in Settings UI and agent-runner env injection.

export const PROVIDER_KEY_REGISTRY: ProviderKeyConfig[] = [
  {
    id: 'github',
    label: 'GitHub Personal Access Token',
    helpUrl: 'https://github.com/settings/tokens',
    description: 'Used for push, PR, and private repo operations.',
    envVar: 'GH_TOKEN',
  },
  {
    id: 'gemini',
    label: 'Google Gemini API Key',
    helpUrl: 'https://aistudio.google.com/apikey',
    description: 'Required for Gemini models (Flash, Pro).',
    envVar: 'GEMINI_API_KEY',
    requiredByProviders: ['gemini', 'deepagent'],
  },
  {
    id: 'openai',
    label: 'OpenAI API Key',
    helpUrl: 'https://platform.openai.com/api-keys',
    description: 'Required for Codex models and Deep Agent GPT-4o.',
    envVar: 'OPENAI_API_KEY',
    requiredByProviders: ['codex', 'deepagent'],
  },
  {
    id: 'minimax',
    label: 'MiniMax API Key',
    helpUrl: 'https://platform.minimax.io',
    description: 'Required by Deep Agent when selecting MiniMax M2.7 models.',
    envVar: 'MINIMAX_API_KEY',
    requiredByProviders: ['deepagent'],
  },
  {
    id: 'zhipuai',
    label: 'zAI API Key',
    helpUrl: 'https://z.ai/manage-apikey/apikey-list',
    description: 'Required by Deep Agent when selecting GLM models.',
    envVar: 'ZHIPUAI_API_KEY',
    requiredByProviders: ['deepagent'],
  },
  {
    id: 'xai',
    label: 'xAI API Key',
    helpUrl: 'https://console.x.ai/',
    description: 'Required by Deep Agent when selecting Grok models.',
    envVar: 'XAI_API_KEY',
    requiredByProviders: ['deepagent'],
  },
  {
    id: 'cursor',
    label: 'Cursor API Key',
    helpUrl: 'https://cursor.com/dashboard',
    description:
      'Used by the Cursor CLI ACP adapter. Alternatively run `cursor-agent login` once on the runner.',
    envVar: 'CURSOR_API_KEY',
    requiredByProviders: ['cursor'],
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI API Key',
    helpUrl: 'https://www.assemblyai.com/dashboard/signup',
    description: 'Enables voice dictation in the prompt input.',
  },
];

// ── Internal lookup helpers ──────────────────────────────────

function isRegistryProvider(provider: AgentProvider): provider is keyof typeof MODEL_REGISTRY {
  return provider in MODEL_REGISTRY;
}

function getModelDefinition(
  provider: AgentProvider,
  model: AgentModel,
): ModelDefinition | undefined {
  if (!isRegistryProvider(provider)) return undefined;
  const bucket = MODEL_REGISTRY[provider] as Record<string, ModelDefinition>;
  return bucket[model as string];
}

// ── Public API ────────────────────────────────────────────────

/** Resolve a friendly model name to the full model ID for the given provider. */
export function resolveModelId(provider: AgentProvider, model: AgentModel): string {
  if (provider === 'llm-api') {
    // LLM API uses full model IDs directly — pass through
    return model as string;
  }
  if (!isRegistryProvider(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  const def = getModelDefinition(provider, model);
  if (!def) {
    // Pi, Cursor and opencode expose their catalogs dynamically (see
    // *-discover.ts). The selected value may already be the wire-format model
    // ID that the Pi SDK, cursor-agent's `unstable_setSessionModel`, or
    // opencode's `session/set_model` expects — pass it through instead of throwing.
    if (provider === 'pi' || provider === 'cursor' || provider === 'opencode') {
      return model as string;
    }
    const providerLabel = PROVIDER_LABELS[provider] ?? provider;
    throw new Error(`Unknown ${providerLabel} model: ${model}`);
  }
  return def.id;
}

/** Get the default model for a provider. */
export function getDefaultModel(provider: AgentProvider): AgentModel {
  if (provider === 'llm-api') return DEFAULT_MODEL;
  if (isRegistryProvider(provider)) return PROVIDER_DEFAULT_MODEL[provider];
  throw new Error(`Unknown provider: ${provider}`);
}

/** Get all available models for a provider. */
export function getProviderModels(provider: AgentProvider): AgentModel[] {
  if (provider === 'llm-api') return [];
  if (isRegistryProvider(provider)) {
    return Object.keys(MODEL_REGISTRY[provider]) as AgentModel[];
  }
  throw new Error(`Unknown provider: ${provider}`);
}

/** Get all available models for a provider with display labels. */
export function getProviderModelsWithLabels(provider: AgentProvider): ModelInfo[] {
  if (!isRegistryProvider(provider)) return [];
  const bucket = MODEL_REGISTRY[provider] as Record<string, ModelDefinition>;
  return Object.entries(bucket).map(([value, def]) => ({
    value: value as AgentModel,
    label: def.label,
  }));
}

/** Get the context window for a model (falls back to 200k if unknown). */
export function getModelContextWindow(provider: AgentProvider, model: AgentModel): number {
  return getModelDefinition(provider, model)?.contextWindow ?? 200_000;
}

/**
 * Get the attachment size limits (inline / upload / hard cap) for a given
 * provider+model pair. Falls back to the provider default.
 */
export function getAttachmentLimits(provider: AgentProvider): AttachmentLimits {
  return PROVIDER_ATTACHMENT_LIMITS[provider] ?? PROVIDER_ATTACHMENT_LIMITS.claude;
}

/** Get the i18n key for a model, or undefined if unknown. */
export function getModelI18nKey(provider: AgentProvider, model: AgentModel): string | undefined {
  return getModelDefinition(provider, model)?.i18nKey;
}

/**
 * Resolve permission mode to the provider-specific SDK value.
 * Returns undefined for providers that don't support permission modes.
 */
export function resolvePermissionMode(
  provider: AgentProvider,
  mode: PermissionMode,
): string | undefined {
  if (provider === 'claude') return CLAUDE_PERMISSION_MAP[mode];
  // Codex, Gemini and opencode map permission/session modes inside their own
  // ACP adapters (e.g. opencode's `session/set_mode`: plan → plan, else build),
  // so the shared resolver returns undefined for them.
  return undefined;
}

/**
 * Resolve permission mode for a session resume.
 * Claude's 'plan' mode must be downgraded to 'acceptEdits' on resume because
 * the plan was already approved in the original session. Other providers
 * don't have permission modes so this is a no-op.
 */
export function resolveResumePermissionMode(
  provider: AgentProvider,
  resolvedMode: string | undefined,
): string | undefined {
  if (provider === 'claude' && resolvedMode === 'plan') return 'acceptEdits';
  return resolvedMode;
}

/** Get default allowed tools for a provider. */
export function getDefaultAllowedTools(provider: AgentProvider): string[] {
  if (provider === 'claude') return [...CLAUDE_DEFAULT_TOOLS];
  if (provider === 'codex') return [...CODEX_DEFAULT_TOOLS];
  if (provider === 'gemini') return [...GEMINI_DEFAULT_TOOLS];
  if (provider === 'pi') return [...PI_DEFAULT_TOOLS];
  if (provider === 'cursor') return [...CURSOR_DEFAULT_TOOLS];
  if (provider === 'opencode') return [...OPENCODE_DEFAULT_TOOLS];
  if (provider === 'deepagent') return [...DEEPAGENT_DEFAULT_TOOLS];
  if (provider === 'llm-api') return [...LLM_API_DEFAULT_TOOLS];
  return [];
}

/** Get read-only tools for ask mode (Claude only). */
export function getAskModeTools(): string[] {
  return [...CLAUDE_ASK_TOOLS];
}

/** Check if a model belongs to the given provider. */
export function isModelForProvider(provider: AgentProvider, model: AgentModel): boolean {
  if (!isRegistryProvider(provider)) return false;
  return (model as string) in MODEL_REGISTRY[provider];
}

// Suppress unused-type warning on ModelsOf for consumers that only want the value map.
export type _ModelsOf<P extends keyof typeof MODEL_REGISTRY> = ModelsOf<P>;
