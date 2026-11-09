/**
 * Pure builder for thread-creation payloads. Centralizes the 3-way decision
 * between scratch / idle / normal threads so call-sites (NewThreadInput,
 * KanbanView, mobile/NewThreadView) stop diverging on field selection.
 *
 * The hook (`use-thread-creation.ts`) wraps this in stateful concerns
 * (creating flag, telemetry, error handling); this file is React-free.
 */

import type { ImageAttachment } from '@funny/shared';
import { parseReferencedFiles, serializeReferencedFiles } from '@funny/shared/attachments';

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

/**
 * Runtime choices for a new thread: local and remote (project launcher). The
 * project's sandbox is a separate on/off toggle (change project-sandboxes).
 */
export function buildRuntimeModes(input: {
  hasLauncher: boolean;
}): Array<{ value: string; label: string }> {
  const modes = [{ value: 'local', label: 'Local' }];
  if (input.hasLauncher) modes.push({ value: 'remote', label: 'Remote' });
  return modes;
}

/** True when the composer starts the thread in the project's sandbox. */
export function isSandboxRuntimeChoice(choice: string | undefined): boolean {
  return choice === 'sandbox';
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
  /** `sandbox` runs it in the caller's project sandbox, resolved by the server. */
  runtime?: string;
  baseBranch?: string;
  sendToBacklog?: boolean;
  fileReferences?: FileRef[];
  symbolReferences?: SymbolRef[];
  /** Files attached before the thread existed (see `threadsApi.stageUpload`). */
  stagedUploads?: string[];
  /** Names of attachments that are not inlined in the prompt (title badge). */
  attachedFileNames?: string[];
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

const TITLE_TEXT_MAX = 200;
const TITLE_MAX = 500;

/**
 * Thread title: the prompt text plus a path-only `<referenced-files>` block
 * listing every attachment — inline files and the uploaded/staged ones — so
 * the attachment badge counts all of them. Falls back to the bare text when
 * the block would push the title past the server's limit.
 */
export function buildThreadTitle(
  prompt: string,
  attachedFileNames: readonly string[] = [],
): string {
  const { entries, body } = parseReferencedFiles(prompt);
  const text = body.slice(0, TITLE_TEXT_MAX);
  const titled = serializeReferencedFiles(
    [
      ...entries.map(({ type, path }) => ({ type, path })),
      ...attachedFileNames.map((path) => ({ type: 'file' as const, path })),
    ],
    text,
  );
  return titled.length <= TITLE_MAX ? titled : text;
}

/**
 * Attachments every create endpoint accepts. Spread as one block into each
 * payload so a thread kind cannot silently drop them (backlog threads used
 * to lose their @-mentions this way). Symbol references stay normal-only:
 * they are resolved at send time and have no stored form yet.
 */
function pickAttachments(opts: SubmitOpts, images: ImageAttachment[] | undefined) {
  return {
    images,
    fileReferences: opts.fileReferences,
    stagedUploads: opts.stagedUploads,
  };
}

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
  const title = buildThreadTitle(prompt, opts.attachedFileNames);

  if (input.isScratch) {
    return {
      kind: 'scratch',
      payload: {
        prompt,
        title,
        provider: opts.provider,
        model: opts.model,
        permissionMode: opts.mode,
        ...pickAttachments(opts, images),
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
        ...pickAttachments(opts, images),
        // `stage` only included when provided — server defaults to 'backlog'.
        ...(input.stage ? { stage: input.stage } : {}),
        // `designId` omitted when undefined — never sent as null.
        ...(designId ? { designId } : {}),
      },
    };
  }

  // Normal: create + execute.
  const { allowedTools, disallowedTools } = deriveToolLists(toolPermissions);
  // A sandbox already isolates the thread, so it always runs in local mode. The
  // server picks the connection and size from the project (project-sandboxes).
  const inSandbox = opts.runtime === 'sandbox';
  return {
    kind: 'normal',
    payload: {
      projectId: input.projectId,
      title,
      mode: inSandbox ? 'local' : threadMode,
      runtime: opts.runtime as 'local' | 'remote' | 'sandbox' | undefined,
      provider: opts.provider,
      model: opts.model,
      permissionMode: opts.mode,
      effort: opts.effort,
      baseBranch: opts.baseBranch,
      prompt,
      ...pickAttachments(opts, images),
      allowedTools,
      disallowedTools,
      symbolReferences: opts.symbolReferences,
      agentTemplateId: opts.agentTemplateId,
      templateVariables: opts.templateVariables,
      ...(designId ? { designId } : {}),
    },
  };
}
