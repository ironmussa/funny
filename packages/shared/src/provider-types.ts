import type { AgentProvider } from './primitives.js';

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

export interface AttachmentLimits {
  inlineMaxBytes: number;
  uploadMaxBytes: number;
  hardMaxBytes: number;
}

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
