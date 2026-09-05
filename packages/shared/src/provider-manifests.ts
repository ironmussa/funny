/**
 * The bundled ACP provider manifests — the single source of truth for every
 * provider-dependent layer (type registry, model catalog, labels, defaults,
 * attachment limits, validation schema, fork allow-list, discovery, client
 * picker). Adding an ACP provider whose behavior is covered by the existing
 * {@link QuirkFlags} menu = authoring one manifest here.
 *
 * This module OWNS the ACP model catalogs (gemini static; cursor/
 * opencode dynamic sentinels). `models.ts` derives `MODEL_REGISTRY` and friends
 * FROM these (runtime import), so manifests must stay a leaf — hence the
 * type-only imports in `provider-manifest.ts`. The Claude SDK, Codex SDK, and
 * DeepAgent catalogs remain in `models.ts`; Pi keeps its sentinel here.
 */

import type { ProviderManifest } from './provider-manifest.js';
import type { ModelDefinition } from './provider-types.js';

const KB = 1024;
const MB = 1024 * 1024;

// ─── ACP model catalogs (owned here; re-exported by models.ts) ───────────────

export const geminiModels = {
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

// Pi/Cursor/opencode route through many underlying providers and expose their
// catalogs dynamically (see *-discover.ts). The static registry only carries a
// `default` sentinel — real model IDs are discovered at runtime and passed
// through `resolveModelId` as wire-format strings.
export const piModels = {
  default: {
    id: 'default',
    label: 'Pi (configured default)',
    contextWindow: 200_000,
    i18nKey: 'piDefault',
  },
} as const satisfies Record<string, ModelDefinition>;

export const cursorModels = {
  default: {
    id: 'default',
    label: 'Cursor (configured default)',
    contextWindow: 200_000,
    i18nKey: 'cursorDefault',
  },
} as const satisfies Record<string, ModelDefinition>;

export const opencodeModels = {
  default: {
    id: 'default',
    label: 'opencode (configured default)',
    contextWindow: 200_000,
    i18nKey: 'opencodeDefault',
  },
} as const satisfies Record<string, ModelDefinition>;

// ─── Manifests ───────────────────────────────────────────────────────────────

export const geminiManifest: ProviderManifest = {
  id: 'gemini',
  label: 'Gemini',
  kind: 'acp',
  spawn: {
    command: 'gemini',
    args: ['--acp'],
    binEnvVars: ['GEMINI_BINARY_PATH', 'ACP_GEMINI_BIN'],
  },
  models: { kind: 'static', entries: geminiModels, defaultModel: 'gemini-3.1-pro-preview' },
  // gemini selects its model via the `--model` CLI arg, not an ACP method.
  modelVia: 'cli-arg',
  // gemini applies autoEdit via the `--yolo` launch flag, not setSessionMode.
  modeVia: 'cli-flag',
  modeMap: { plan: null, ask: null, confirmEdit: null, auto: null, autoEdit: null },
  forkCapabilityPaths: ['sessions.fork'],
  builtinTools: [
    'read_file',
    'write_file',
    'replace',
    'list_directory',
    'glob',
    'grep_search',
    'run_shell_command',
    'web_fetch',
    'google_web_search',
    'codebase_investigator',
    'save_memory',
    'ask_user',
    'activate_skill',
    'cli_help',
  ],
  attachmentLimits: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 18 * MB, hardMaxBytes: 20 * MB },
  auth: { mode: 'provider-key', providerKeyId: 'gemini' },
  prelaunch: 'gemini-trust-folder',
  quirks: {
    bufferPreambleAsThink: true,
    planRender: 'text',
    synthToolUseFromOrphanUpdate: true,
    permissionModel: 'gated',
  },
};

export const cursorManifest: ProviderManifest = {
  id: 'cursor',
  label: 'Cursor',
  kind: 'acp',
  spawn: {
    command: 'cursor-agent',
    args: ['acp'],
    binEnvVars: ['CURSOR_BINARY_PATH', 'ACP_CURSOR_BIN'],
    npxSpec: { useEnvVar: 'CURSOR_ACP_USE_NPX', pkg: ['-y', 'cursor-agent', 'acp'] },
  },
  models: { kind: 'dynamic', sentinel: cursorModels.default, defaultModel: 'default' },
  setModel: { method: 'unstable_setSessionModel' },
  modelVia: 'acp-method',
  modeVia: 'none',
  modeMap: { plan: null, ask: null, confirmEdit: null, auto: null, autoEdit: null },
  forkCapabilityPaths: ['sessions.fork'],
  builtinTools: [
    'read_file',
    'write_file',
    'edit_file',
    'list_dir',
    'glob_file_search',
    'grep_search',
    'run_terminal_cmd',
    'web_search',
    'fetch_url',
    'todo_write',
  ],
  attachmentLimits: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  auth: { mode: 'provider-key', providerKeyId: 'cursor' },
  quirks: {
    planRender: 'todoCard',
    deferUnrenderableToolInput: true,
    synthToolUseFromOrphanUpdate: true,
    permissionModel: 'gated',
    filterMcpByCapability: true,
  },
};

export const opencodeManifest: ProviderManifest = {
  id: 'opencode',
  label: 'opencode',
  kind: 'acp',
  spawn: {
    command: 'opencode',
    args: ['acp'],
    binEnvVars: ['OPENCODE_BIN', 'ACP_OPENCODE_BIN'],
    npxSpec: { useEnvVar: 'OPENCODE_ACP_USE_NPX', pkg: ['-y', 'opencode-ai', 'acp'] },
  },
  models: { kind: 'dynamic', sentinel: opencodeModels.default, defaultModel: 'default' },
  // opencode does NOT advertise setSessionModel; it implements the raw
  // `session/set_model` ACP method, invoked via the SDK extMethod escape hatch.
  setModel: { method: 'session/set_model' },
  modelVia: 'acp-method',
  modeVia: 'acp-setSessionMode',
  // opencode session modes: build | plan (plan → plan, everything else → build)
  modeMap: {
    plan: 'plan',
    ask: 'build',
    confirmEdit: 'build',
    auto: 'build',
    autoEdit: 'build',
  },
  // opencode advertises fork under sessionCapabilities.fork (not sessions.fork)
  forkCapabilityPaths: ['sessionCapabilities.fork'],
  builtinTools: [
    'read',
    'write',
    'edit',
    'patch',
    'bash',
    'glob',
    'grep',
    'list',
    'webfetch',
    'todowrite',
    'todoread',
    'task',
  ],
  attachmentLimits: { inlineMaxBytes: 100 * KB, uploadMaxBytes: 10 * MB, hardMaxBytes: 15 * MB },
  auth: { mode: 'runner-preauth' },
  quirks: {
    planRender: 'todoCard',
    deferUnrenderableToolInput: true,
    synthToolUseFromOrphanUpdate: true,
    permissionModel: 'gated',
    filterMcpByCapability: true,
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

/** All bundled ACP provider manifests, keyed by provider id. */
export const ACP_MANIFESTS = {
  gemini: geminiManifest,
  cursor: cursorManifest,
  opencode: opencodeManifest,
} as const satisfies Record<string, ProviderManifest>;

/** Compile-time known ACP provider ids (the bundled set). */
export type KnownAcpProvider = keyof typeof ACP_MANIFESTS;

/** Runtime list of bundled ACP provider ids. */
export const KNOWN_ACP_PROVIDER_IDS = Object.keys(ACP_MANIFESTS) as KnownAcpProvider[];

/** Bundled ACP providers that still launch through an ACP CLI and can be toggled off. */
export type GateableAcpProvider = KnownAcpProvider;
export const GATEABLE_ACP_PROVIDER_IDS = KNOWN_ACP_PROVIDER_IDS;

/** ACP providers whose catalog is discovered at runtime (`models.kind: 'dynamic'`). */
export const DYNAMIC_ACP_PROVIDER_IDS = KNOWN_ACP_PROVIDER_IDS.filter(
  (id) => ACP_MANIFESTS[id].models.kind === 'dynamic',
);

/** Providers with dynamic model discovery, including non-ACP SDK providers. */
export const DYNAMIC_MODEL_PROVIDER_IDS = ['pi', ...DYNAMIC_ACP_PROVIDER_IDS] as const;

/** Look up a manifest by provider id (any string; returns undefined if unknown). */
export function getManifest(providerId: string): ProviderManifest | undefined {
  return (ACP_MANIFESTS as Record<string, ProviderManifest>)[providerId];
}

/** True when the provider id is a bundled ACP provider. */
export function isAcpManifestProvider(providerId: string): boolean {
  return providerId in ACP_MANIFESTS;
}
