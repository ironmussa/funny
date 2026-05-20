/**
 * Pure builder for the `api.sendMessage` opts payload. Used by both the
 * normal-send path and the follow-up dialog path in use-thread-handlers so
 * the same field selection (provider/model/permissionMode/effort + derived
 * allowed/disallowed tools + file/symbol refs + baseBranch) lives in one
 * place.
 *
 * Mirrors the structure of `thread-payload.ts` (creation-side); this one
 * targets follow-ups on existing threads.
 */

import { deriveToolLists, type ToolPermission } from '@/stores/settings-store';

export interface SendMessageOpts {
  provider?: string;
  model?: string;
  /** PermissionMode — named `mode` in PromptInput's onSubmit. */
  mode?: string;
  effort?: string;
  fileReferences?: { path: string; type?: 'file' | 'folder' }[];
  symbolReferences?: {
    path: string;
    name: string;
    kind: string;
    line: number;
    endLine?: number;
  }[];
  baseBranch?: string;
}

export interface SendMessagePayload {
  provider?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  allowedTools: string[];
  disallowedTools: string[];
  fileReferences?: { path: string }[];
  symbolReferences?: {
    path: string;
    name: string;
    kind: string;
    line: number;
    endLine?: number;
  }[];
  baseBranch?: string;
}

/**
 * Build the opts payload `api.sendMessage` expects.
 *
 * - `mode` (PromptInput-side name) maps to `permissionMode` (API-side name).
 * - `toolPermissions` is captured at submit time (callers pass the current
 *   snapshot, not the render-time one) so a permission toggle mid-compose
 *   is honored.
 * - `effort`-bearing path is the only divergence vs the follow-up dialog,
 *   which passes `includeEffort: false`.
 */
export function buildSendMessagePayload(
  opts: SendMessageOpts,
  toolPermissions: Record<string, ToolPermission>,
  options: { includeEffort?: boolean } = {},
): SendMessagePayload {
  const { allowedTools, disallowedTools } = deriveToolLists(toolPermissions);
  return {
    provider: opts.provider || undefined,
    model: opts.model || undefined,
    permissionMode: opts.mode || undefined,
    ...(options.includeEffort !== false ? { effort: opts.effort || undefined } : {}),
    allowedTools,
    disallowedTools,
    fileReferences: opts.fileReferences,
    symbolReferences: opts.symbolReferences,
    baseBranch: opts.baseBranch,
  };
}
