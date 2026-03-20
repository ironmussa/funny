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
  DeepAgentModel,
  PermissionMode,
} from './types.js';
// ── Application defaults (single source of truth) ────────────────
// Change these values to update defaults across the entire codebase.
import type { FollowUpMode, ThreadMode } from './types.js';

export const DEFAULT_PROVIDER: AgentProvider = 'claude';
export const DEFAULT_MODEL: AgentModel = 'opus';
export const DEFAULT_THREAD_MODE: ThreadMode = 'local';
export const DEFAULT_FOLLOW_UP_MODE: FollowUpMode = 'queue';
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'autoEdit';

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

const DEEPAGENT_MODEL_IDS: Record<DeepAgentModel, string> = {
  'minimax-m2.7': 'minimax:MiniMax-M2.7',
  'minimax-m2.7-highspeed': 'minimax:MiniMax-M2.7-highspeed',
  'deepagent-gpt-4o': 'openai:gpt-4o',
  'deepagent-sonnet': 'anthropic:claude-sonnet-4-5-20250929',
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

const DEEPAGENT_MODEL_LABELS: Record<DeepAgentModel, string> = {
  'minimax-m2.7': 'MiniMax M2.7',
  'minimax-m2.7-highspeed': 'MiniMax M2.7 Highspeed',
  'deepagent-gpt-4o': 'GPT-4o',
  'deepagent-sonnet': 'Sonnet 4.5',
};

// ── Provider labels ─────────────────────────────────────────────

export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  deepagent: 'Deep Agent',
};

// ── Permission mode mapping (Claude SDK specific) ─────────────

const CLAUDE_PERMISSION_MAP: Record<PermissionMode, string> = {
  plan: 'plan',
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
    id: 'minimax',
    label: 'MiniMax API Key',
    helpUrl: 'https://platform.minimax.io',
    description: 'Required by Deep Agent when selecting MiniMax M2.7 models.',
    envVar: 'MINIMAX_API_KEY',
    requiredByProviders: ['deepagent'],
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI API Key',
    helpUrl: 'https://www.assemblyai.com/dashboard/signup',
    description: 'Enables voice dictation in the prompt input.',
  },
];

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
  if (provider === 'deepagent') {
    const id = DEEPAGENT_MODEL_IDS[model as DeepAgentModel];
    if (!id) throw new Error(`Unknown Deep Agent model: ${model}`);
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
  if (provider === 'claude') return DEFAULT_MODEL;
  if (provider === 'codex') return 'o4-mini';
  if (provider === 'gemini') return 'gemini-3-flash-preview';
  if (provider === 'deepagent') return 'minimax-m2.7';
  if (provider === 'llm-api') return DEFAULT_MODEL; // Default to claude-equivalent
  throw new Error(`Unknown provider: ${provider}`);
}

/** Get all available models for a provider. */
export function getProviderModels(provider: AgentProvider): AgentModel[] {
  if (provider === 'claude') return Object.keys(CLAUDE_MODEL_IDS) as ClaudeModel[];
  if (provider === 'codex') return Object.keys(CODEX_MODEL_IDS) as CodexModel[];
  if (provider === 'gemini') return Object.keys(GEMINI_MODEL_IDS) as GeminiModel[];
  if (provider === 'deepagent') return Object.keys(DEEPAGENT_MODEL_IDS) as DeepAgentModel[];
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
  if (provider === 'deepagent') {
    return (Object.keys(DEEPAGENT_MODEL_LABELS) as DeepAgentModel[]).map((k) => ({
      value: k,
      label: DEEPAGENT_MODEL_LABELS[k],
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

// Deep Agent manages its own tools via LangGraph — no default tool list needed
const DEEPAGENT_DEFAULT_TOOLS: string[] = [];

// LLM API manages its own tools via ToolRunner — no default tool list needed
const LLM_API_DEFAULT_TOOLS = ['bash', 'read', 'edit', 'glob', 'grep'];

/** Get default allowed tools for a provider. */
export function getDefaultAllowedTools(provider: AgentProvider): string[] {
  if (provider === 'claude') return [...CLAUDE_DEFAULT_TOOLS];
  if (provider === 'codex') return [...CODEX_DEFAULT_TOOLS];
  if (provider === 'gemini') return [...GEMINI_DEFAULT_TOOLS];
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
  if (provider === 'claude') return model in CLAUDE_MODEL_IDS;
  if (provider === 'codex') return model in CODEX_MODEL_IDS;
  if (provider === 'gemini') return model in GEMINI_MODEL_IDS;
  if (provider === 'deepagent') return model in DEEPAGENT_MODEL_IDS;
  return false;
}
