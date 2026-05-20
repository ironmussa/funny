/**
 * Pure builder for thread-creation payloads. Centralizes the 3-way decision
 * between scratch / idle / normal threads so call-sites (NewThreadInput,
 * KanbanView, mobile/NewThreadView) stop diverging on field selection.
 *
 * The hook (`use-thread-creation.ts`) wraps this in stateful concerns
 * (creating flag, telemetry, error handling); this file is React-free.
 */

import type { ImageAttachment } from '@funny/shared';

import { deriveToolLists, type ToolPermission } from '@/stores/settings-store';

export type ThreadKind = 'scratch' | 'idle' | 'normal';

export interface FileRef {
  path: string;
  type?: 'file' | 'folder';
}
export interface SymbolRef {
  path: string;
  name: string;
  kind: string;
  line: number;
  endLine?: number;
}

/** Per-submit options coming from PromptInput. */
export interface SubmitOpts {
  provider?: string;
  model: string;
  /** PermissionMode — named `mode` in PromptInput's onSubmit. */
  mode: string;
  effort?: string;
  /** local | worktree — named `threadMode` in PromptInput's onSubmit. */
  threadMode?: string;
  runtime?: string;
  baseBranch?: string;
  sendToBacklog?: boolean;
  fileReferences?: FileRef[];
  symbolReferences?: SymbolRef[];
  agentTemplateId?: string;
  templateVariables?: Record<string, string>;
}

/** Per-call context the form provides. */
export interface BuildInput {
  /** Project ID. Required for idle/normal; ignored when isScratch. */
  projectId: string | null;
  prompt: string;
  opts: SubmitOpts;
  images?: ImageAttachment[];
  /** Forces the scratch branch — wins over forceIdle/stage. */
  isScratch?: boolean;
  /** Forces the idle branch (e.g. "send to backlog" toggle, idle-only mode). */
  forceIdle?: boolean;
  /** Stage to set on idle threads. Kanban uses 'planning' for that column. */
  stage?: 'backlog' | 'planning';
  /** Default mode when `opts.threadMode` is not provided (project default). */
  defaultThreadMode: 'local' | 'worktree';
  /** Tool permissions map — captured at submit time, not from React render. */
  toolPermissions: Record<string, ToolPermission>;
  /** Design context (only included when defined; never sent as null). */
  designId?: string;
}

export type ScratchPayload = Parameters<
  typeof import('./api/threads').threadsApi.createScratchThread
>[0];
export type IdlePayload = Parameters<typeof import('./api/threads').threadsApi.createIdleThread>[0];
export type NormalPayload = Parameters<typeof import('./api/threads').threadsApi.createThread>[0];

export type BuildResult =
  | { kind: 'scratch'; payload: ScratchPayload }
  | { kind: 'idle'; payload: IdlePayload }
  | { kind: 'normal'; payload: NormalPayload };

/**
 * Decide which create-endpoint to call and build the matching payload.
 * Pure function — no React, no API calls, no state.
 *
 * Decision order: scratch > idle > normal.
 */
export function buildThreadPayload(input: BuildInput): BuildResult {
  const { prompt, opts, images, designId, defaultThreadMode, toolPermissions } = input;
  const title = prompt.slice(0, 200);

  if (input.isScratch) {
    return {
      kind: 'scratch',
      payload: {
        prompt,
        title,
        provider: opts.provider,
        model: opts.model,
        permissionMode: opts.mode,
        images,
      },
    };
  }

  if (!input.projectId) {
    throw new Error('projectId is required for idle/normal threads');
  }

  const threadMode = (opts.threadMode as 'local' | 'worktree') || defaultThreadMode;
  const isIdle = input.forceIdle || opts.sendToBacklog === true;

  if (isIdle) {
    return {
      kind: 'idle',
      payload: {
        projectId: input.projectId,
        title,
        mode: threadMode,
        baseBranch: opts.baseBranch,
        prompt,
        images,
        // `stage` only included when provided — server defaults to 'backlog'.
        ...(input.stage ? { stage: input.stage } : {}),
        // `designId` omitted when undefined — never sent as null.
        ...(designId ? { designId } : {}),
      },
    };
  }

  // Normal: create + execute.
  const { allowedTools, disallowedTools } = deriveToolLists(toolPermissions);
  return {
    kind: 'normal',
    payload: {
      projectId: input.projectId,
      title,
      mode: threadMode,
      runtime: opts.runtime as 'local' | 'remote' | undefined,
      provider: opts.provider,
      model: opts.model,
      permissionMode: opts.mode,
      effort: opts.effort,
      baseBranch: opts.baseBranch,
      prompt,
      images,
      allowedTools,
      disallowedTools,
      fileReferences: opts.fileReferences,
      symbolReferences: opts.symbolReferences,
      agentTemplateId: opts.agentTemplateId,
      templateVariables: opts.templateVariables,
      ...(designId ? { designId } : {}),
    },
  };
}
