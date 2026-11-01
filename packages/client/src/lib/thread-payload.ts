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
export type ThreadMode = 'local' | 'worktree';

interface SlashCommandResource {
  name: string;
  threadMode?: ThreadMode;
}

const LEADING_SLASH_COMMAND_RE = /^\s*\/([A-Za-z0-9_:-]+)(?:\s|$)/;

export function getLeadingSlashCommand(prompt: string): string | undefined {
  return prompt.match(LEADING_SLASH_COMMAND_RE)?.[1];
}

export function resolveSlashCommandThreadMode(
  prompt: string,
  skills: Pick<SlashCommandResource, 'name' | 'threadMode'>[],
): ThreadMode | undefined {
  const command = getLeadingSlashCommand(prompt);
  if (!command) return undefined;
  return skills.find((skill) => skill.name === command)?.threadMode;
}

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

const SANDBOX_RUNTIME_PREFIX = 'sandbox:';

/**
 * Runtime choices for a new thread: local, remote (project launcher) and one
 * sandbox entry per provider connection (`sandbox:<connectionId>`). Scratch
 * threads have no repository to clone, so they never get sandbox entries.
 */
export function buildRuntimeModes(input: {
  hasLauncher: boolean;
  sandboxConnections: ReadonlyArray<{ id: string; label: string }>;
  isScratch: boolean;
}): Array<{ value: string; label: string }> {
  const modes = [{ value: 'local', label: 'Local' }];
  if (input.hasLauncher) modes.push({ value: 'remote', label: 'Remote' });
  if (!input.isScratch) {
    for (const connection of input.sandboxConnections) {
      modes.push({
        value: `${SANDBOX_RUNTIME_PREFIX}${connection.id}`,
        label: `Sandbox · ${connection.label}`,
      });
    }
  }
  return modes;
}

/** Splits a runtime choice into the thread runtime and its sandbox connection. */
export function parseRuntimeChoice(choice: string | undefined): {
  runtime?: string;
  sandboxConnectionId?: string;
} {
  if (choice?.startsWith(SANDBOX_RUNTIME_PREFIX)) {
    return { runtime: 'sandbox', sandboxConnectionId: choice.slice(SANDBOX_RUNTIME_PREFIX.length) };
  }
  return { runtime: choice };
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
  /** Provider connection used when `runtime === 'sandbox'`. */
  sandboxConnectionId?: string;
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
  // A sandbox already isolates the thread, so it always runs in local mode.
  const sandbox =
    opts.runtime === 'sandbox' && opts.sandboxConnectionId
      ? { connectionId: opts.sandboxConnectionId }
      : undefined;
  return {
    kind: 'normal',
    payload: {
      projectId: input.projectId,
      title,
      mode: sandbox ? 'local' : threadMode,
      runtime: opts.runtime as 'local' | 'remote' | 'sandbox' | undefined,
      ...(sandbox ? { sandbox } : {}),
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
