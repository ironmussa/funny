/**
 * Centralized model registry for all agent providers.
 * Maps friendly model names to full model IDs and provides helpers.
 */

import type {
  AgentProvider,
  AgentModel,
  ClaudeModel,
  CodexModel,
  GeminiModel,
  PermissionMode,
} from './types.js';

// ── Model ID mappings ─────────────────────────────────────────

const CLAUDE_MODEL_IDS: Record<ClaudeModel, string> = {
  sonnet: 'claude-sonnet-4-5-20250929',
  'sonnet-4.6': 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

const CODEX_MODEL_IDS: Record<CodexModel, string> = {
  o3: 'o3',
  'o4-mini': 'o4-mini',
  'codex-mini': 'codex-mini',
};

const GEMINI_MODEL_IDS: Record<GeminiModel, string> = {
  'gemini-2.0-flash': 'gemini-2.0-flash',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-3-flash-preview': 'gemini-3-flash-preview',
  'gemini-3-pro-preview': 'gemini-3-pro-preview',
};

// ── Model display labels ────────────────────────────────────────

export interface ModelInfo {
  value: AgentModel;
  label: string;
}

const CLAUDE_MODEL_LABELS: Record<ClaudeModel, string> = {
  haiku: 'Haiku 4.5',
  sonnet: 'Sonnet 4.5',
  'sonnet-4.6': 'Sonnet 4.6',
  opus: 'Opus 4.6',
};

const CODEX_MODEL_LABELS: Record<CodexModel, string> = {
  o3: 'o3',
  'o4-mini': 'o4-mini',
  'codex-mini': 'Codex Mini',
};

const GEMINI_MODEL_LABELS: Record<GeminiModel, string> = {
  'gemini-3-flash-preview': 'Gemini 3 Flash',
  'gemini-3-pro-preview': 'Gemini 3 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.0-flash': 'Gemini 2.0 Flash',
};

// ── Provider labels ─────────────────────────────────────────────

export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};

// ── Permission mode mapping (Claude SDK specific) ─────────────

const CLAUDE_PERMISSION_MAP: Record<PermissionMode, string> = {
  plan: 'plan',
  autoEdit: 'bypassPermissions',
  confirmEdit: 'default',
  ask: 'default',
};

// ── Ask-mode tools (read-only) ───────────────────────────────

const CLAUDE_ASK_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task'];

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

// ── Public API ────────────────────────────────────────────────

/** Resolve a friendly model name to the full model ID for the given provider. */
export function resolveModelId(provider: AgentProvider, model: AgentModel): string {
  if (provider === 'claude') {
    const id = CLAUDE_MODEL_IDS[model as ClaudeModel];
    if (!id) throw new Error(`Unknown Claude model: ${model}`);
    return id;
  }
  if (provider === 'codex') {
    const id = CODEX_MODEL_IDS[model as CodexModel];
    if (!id) throw new Error(`Unknown Codex model: ${model}`);
    return id;
  }
  if (provider === 'gemini') {
    const id = GEMINI_MODEL_IDS[model as GeminiModel];
    if (!id) throw new Error(`Unknown Gemini model: ${model}`);
    return id;
  }
  if (provider === 'llm-api') {
    // LLM API uses full model IDs directly — pass through
    return model as string;
  }
  throw new Error(`Unknown provider: ${provider}`);
}

/** Get the default model for a provider. */
export function getDefaultModel(provider: AgentProvider): AgentModel {
  if (provider === 'claude') return 'sonnet';
  if (provider === 'codex') return 'o4-mini';
  if (provider === 'gemini') return 'gemini-3-flash-preview';
  if (provider === 'llm-api') return 'sonnet'; // Default to sonnet-equivalent
  throw new Error(`Unknown provider: ${provider}`);
}

/** Get all available models for a provider. */
export function getProviderModels(provider: AgentProvider): AgentModel[] {
  if (provider === 'claude') return Object.keys(CLAUDE_MODEL_IDS) as ClaudeModel[];
  if (provider === 'codex') return Object.keys(CODEX_MODEL_IDS) as CodexModel[];
  if (provider === 'gemini') return Object.keys(GEMINI_MODEL_IDS) as GeminiModel[];
  if (provider === 'llm-api') return []; // LLM API accepts any model ID
  throw new Error(`Unknown provider: ${provider}`);
}

/** Get all available models for a provider with display labels. */
export function getProviderModelsWithLabels(provider: AgentProvider): ModelInfo[] {
  if (provider === 'claude') {
    return (Object.keys(CLAUDE_MODEL_LABELS) as ClaudeModel[]).map((k) => ({
      value: k,
      label: CLAUDE_MODEL_LABELS[k],
    }));
  }
  if (provider === 'codex') {
    return (Object.keys(CODEX_MODEL_LABELS) as CodexModel[]).map((k) => ({
      value: k,
      label: CODEX_MODEL_LABELS[k],
    }));
  }
  if (provider === 'gemini') {
    return (Object.keys(GEMINI_MODEL_LABELS) as GeminiModel[]).map((k) => ({
      value: k,
      label: GEMINI_MODEL_LABELS[k],
    }));
  }
  return [];
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
  // Codex and Gemini don't have permission modes — they run autonomously
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

// LLM API manages its own tools via ToolRunner — no default tool list needed
const LLM_API_DEFAULT_TOOLS = ['bash', 'read', 'edit', 'glob', 'grep'];

/** Get default allowed tools for a provider. */
export function getDefaultAllowedTools(provider: AgentProvider): string[] {
  if (provider === 'claude') return [...CLAUDE_DEFAULT_TOOLS];
  if (provider === 'codex') return [...CODEX_DEFAULT_TOOLS];
  if (provider === 'gemini') return [...GEMINI_DEFAULT_TOOLS];
  if (provider === 'llm-api') return [...LLM_API_DEFAULT_TOOLS];
  return [];
}

/** Get read-only tools for ask mode (Claude only). */
export function getAskModeTools(): string[] {
  return [...CLAUDE_ASK_TOOLS];
}

/** Check if a model belongs to the given provider. */
export function isModelForProvider(provider: AgentProvider, model: AgentModel): boolean {
  if (provider === 'claude') return model in CLAUDE_MODEL_IDS;
  if (provider === 'codex') return model in CODEX_MODEL_IDS;
  if (provider === 'gemini') return model in GEMINI_MODEL_IDS;
  return false;
}
