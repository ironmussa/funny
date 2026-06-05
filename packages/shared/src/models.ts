/**
 * Centralized model registry for all agent providers.
 *
 * Single source of truth: `MODEL_REGISTRY` drives model IDs, labels,
 * context windows, i18n keys, and the TypeScript unions below. Zod
 * schemas (runtime) and the client's provider catalog derive from
 * this file too — do not duplicate model lists elsewhere.
 */

import type { AgentProvider, FollowUpMode, PermissionMode, ThreadMode } from './primitives.js';

// ── Application defaults ────────────────────────────────────────
// Change these values to update defaults across the entire codebase.

export const DEFAULT_PROVIDER: AgentProvider = 'claude';
export const DEFAULT_THREAD_MODE: ThreadMode = 'local';
export const DEFAULT_FOLLOW_UP_MODE: FollowUpMode = 'queue';
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'autoEdit';

// ── Model registry (single source of truth) ────────────────────

export interface ModelDefinition {
  /** Full model ID passed to the provider SDK / CLI. */
  id: string;
  /** Display label shown when no i18n translation is available. */
  label: string;
  /** Context window size in tokens. */
  contextWindow: number;
  /** i18n key under `thread.model.*` on the client. */
  i18nKey: string;
}

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
export interface AttachmentLimits {
  inlineMaxBytes: number;
  uploadMaxBytes: number;
  hardMaxBytes: number;
}

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
} as const satisfies Record<string, ModelDefinition>;

const codexModels = {
  'gpt-5.4': {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    contextWindow: 400_000,
    i18nKey: 'gpt54',
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    contextWindow: 400_000,
    i18nKey: 'gpt54mini',
  },
  'gpt-5.3-codex': {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    contextWindow: 400_000,
    i18nKey: 'gpt53codex',
  },
  'gpt-5.2': {
    id: 'gpt-5.2',
    label: 'GPT-5.2',
    contextWindow: 400_000,
    i18nKey: 'gpt52',
  },
} as const satisfies Record<string, ModelDefinition>;

const geminiModels = {
  'gemini-3.1-pro-preview': {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    contextWindow: 1_000_000,
    i18nKey: 'gemini31pro',
  },
  'gemini-3-flash-preview': {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    contextWindow: 1_000_000,
    i18nKey: 'gemini3flash',
  },
  'gemini-3.1-flash-lite-preview': {
    id: 'gemini-3.1-flash-lite-preview',
    label: 'Gemini 3.1 Flash Lite',
    contextWindow: 1_000_000,
    i18nKey: 'gemini31flashLite',
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    contextWindow: 1_048_576,
    i18nKey: 'gemini25pro',
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    contextWindow: 1_048_576,
    i18nKey: 'gemini25flash',
  },
  'gemini-2.0-flash': {
    id: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    contextWindow: 1_048_576,
    i18nKey: 'gemini20flash',
  },
} as const satisfies Record<string, ModelDefinition>;

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

// Pi (https://github.com/badlogic/pi-mono) routes through multiple
// underlying providers and exposes its catalog dynamically. The static
// registry only carries the `default` sentinel — actual model IDs are
// discovered at runtime via the `/system/pi/models` endpoint and passed
// through `resolveModelId` as wire-format strings (e.g. `google/gemini-3.1-pro`).
const piModels = {
  default: {
    id: 'default',
    label: 'Pi (configured default)',
    contextWindow: 200_000,
    i18nKey: 'piDefault',
  },
} as const satisfies Record<string, ModelDefinition>;

// Cursor CLI (https://cursor.com/docs/cli/acp) exposes its catalog through
// the ACP session/new response. Like pi, the static registry only carries
// the `default` sentinel — real model IDs are discovered at runtime via
// `/system/cursor/models` and passed through `resolveModelId` as wire-format
// strings that cursor's `unstable_setSessionModel` accepts.
const cursorModels = {
  default: {
    id: 'default',
    label: 'Cursor (configured default)',
    contextWindow: 200_000,
    i18nKey: 'cursorDefault',
  },
} as const satisfies Record<string, ModelDefinition>;

// opencode (https://opencode.ai) routes to many underlying model providers
// configured by the user and advertises its catalog over ACP — `session/new`
// returns `models.availableModels: [{ modelId, name }]` (same shape as cursor).
// The static registry only carries the `default` sentinel; real model IDs are
// discovered at runtime via `/system/opencode/models` and passed through
// `resolveModelId` as wire-format strings (e.g. `opencode/gpt-5-nano/high`,
// where the trailing segment is the reasoning-effort variant).
const opencodeModels = {
  default: {
    id: 'default',
    label: 'opencode (configured default)',
    contextWindow: 200_000,
    i18nKey: 'opencodeDefault',
  },
} as const satisfies Record<string, ModelDefinition>;

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

const PROVIDER_DEFAULT_MODEL: Record<keyof typeof MODEL_REGISTRY, AgentModel> = {
  claude: DEFAULT_MODEL,
  codex: 'gpt-5.4',
  gemini: 'gemini-3.1-pro-preview',
  pi: 'default',
  cursor: 'default',
  opencode: 'default',
  deepagent: 'minimax-m2.7',
};

// ── Per-provider attachment limits ────────────────────────────
// Values track upstream API ceilings: Anthropic accepts ~32 MB per request,
// Gemini caps inline data at ~20 MB before requiring the Files API, OpenAI
// (Codex) accepts ~25 MB. We keep `inlineMaxBytes` low (100 KB) across the
// board so the prompt stays cheap per turn — larger files should go through
// the upload path so the agent reads them on demand with the Read tool.

const KB = 1024;
const MB = 1024 * 1024;

const PROVIDER_ATTACHMENT_LIMITS: Record<AgentProvider, AttachmentLimits> = {
  claude: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 25 * MB, hardMaxBytes: 30 * MB },
  codex: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 20 * MB, hardMaxBytes: 25 * MB },
  gemini: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 18 * MB, hardMaxBytes: 20 * MB },
  // Pi, Cursor and DeepAgent route through multiple upstream providers — use
  // the smallest common ceiling so we never exceed the weakest backend.
  pi: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  cursor: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  opencode: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  deepagent: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  'llm-api': { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  external: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
};

// ── Provider labels ──────────────────────────────────────────

export interface ModelInfo {
  value: AgentModel;
  label: string;
}

export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  pi: 'Pi',
  cursor: 'Cursor',
  opencode: 'opencode',
  deepagent: 'Deep Agent',
};

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

export interface ProviderKeyConfig {
  /** Canonical identifier stored in the provider_keys JSON column. */
  id: string;
  /** Human-readable label for the Settings UI. */
  label: string;
  /** URL where the user can obtain this key. */
  helpUrl: string;
  /** Description shown in the Settings UI. */
  description: string;
  /** Environment variable name to inject when launching agent subprocesses. */
  envVar?: string;
  /** Which agent providers require this key at runtime. */
  requiredByProviders?: AgentProvider[];
}

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
    // ID that pi-acp / cursor-agent's `unstable_setSessionModel` or opencode's
    // `session/set_model` expects — pass it through instead of throwing.
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
