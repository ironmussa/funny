/**
 * Pure helpers for the PromptInputUI submit pipeline: attachment shaping,
 * provider-setup gating and the `onSubmit` option payload.
 */
import type { ImageAttachment, TemplateVariable } from '@funny/shared';
import { serializeReferencedFiles } from '@funny/shared/attachments';

import { parseRuntimeChoice, type FileRef, type SymbolRef } from '@/lib/thread-payload';

/**
 * Attached files: small text files are inlined (`mode: 'inline'`, content is
 * embedded in the prompt on submit); the rest is uploaded to the runner —
 * into the thread (`mode: 'upload'`, sent as a fileReference) or, before the
 * thread exists, into the staging area (`mode: 'staged'`, sent as
 * `stagedUploads` and adopted on creation). `mode: 'uploading'` marks an
 * upload in flight.
 */
export type AttachedTextFile =
  | { mode: 'inline'; name: string; content: string; size: number }
  | { mode: 'upload'; name: string; path: string; size: number }
  | { mode: 'staged'; name: string; stagedId: string; size: number }
  | { mode: 'uploading'; name: string; size: number };

export interface PromptSubmitOptions {
  provider?: string;
  model: string;
  mode: string;
  effort?: string;
  threadMode?: string;
  runtime?: string;
  /** Provider connection used when `runtime === 'sandbox'`. */
  sandboxConnectionId?: string;
  baseBranch?: string;
  cwd?: string;
  sendToBacklog?: boolean;
  fileReferences?: FileRef[];
  symbolReferences?: SymbolRef[];
  stagedUploads?: string[];
  /** Names of attachments not inlined in the prompt (shown in the thread title badge). */
  attachedFileNames?: string[];
  agentTemplateId?: string;
  templateVariables?: Record<string, string>;
}

export interface SerializedPrompt {
  text: string;
  fileReferences: FileRef[];
  symbolReferences: SymbolRef[];
}

export const EMPTY_SERIALIZED_PROMPT: SerializedPrompt = {
  text: '',
  fileReferences: [],
  symbolReferences: [],
};

/** Codex commands must be sent on their own, without any attachment. */
export function hasPromptAttachments(
  serialized: SerializedPrompt,
  imageCount: number,
  textFileCount: number,
): boolean {
  return (
    imageCount > 0 ||
    textFileCount > 0 ||
    serialized.fileReferences.length > 0 ||
    serialized.symbolReferences.length > 0
  );
}

const SETUP_BLOCKING_STATES = ['missing', 'failed', 'installing'];

/** True when the provider must be installed/authenticated before sending. */
export function providerNeedsSetup(
  provider: string,
  setup: { state: string; auth?: string | null },
): boolean {
  if (SETUP_BLOCKING_STATES.includes(setup.state)) return true;
  if (setup.auth === 'required') return true;
  return setup.state === 'bundled' && setup.auth !== 'configured' && provider === 'claude';
}

export function isUploadInFlight(files: readonly AttachedTextFile[]): boolean {
  return files.some((f) => f.mode === 'uploading');
}

/**
 * Inline-tier files: embed contents in the prompt's <referenced-files> block
 * (browsers can't expose paths for these small dropped files).
 */
function withInlineFiles(files: readonly AttachedTextFile[], text: string): string {
  const inlineFiles = files.filter(
    (f): f is Extract<AttachedTextFile, { mode: 'inline' }> => f.mode === 'inline',
  );
  return serializeReferencedFiles(
    inlineFiles.map((f) => ({ type: 'file' as const, path: f.name, content: f.content })),
    text,
  );
}

/**
 * Upload-tier files: send their on-disk path as a fileReference so the
 * server can resolve them via augmentPromptWithFiles (which falls back to
 * a "use Read tool" note when the file exceeds the inline cap).
 */
function collectUploadedRefs(files: readonly AttachedTextFile[]): FileRef[] {
  return files
    .filter((f): f is Extract<AttachedTextFile, { mode: 'upload' }> => f.mode === 'upload')
    .map((f) => ({ path: f.path, type: 'file' as const }));
}

/** Staged files (attached before the thread existed): adopted on creation. */
function collectStagedIds(files: readonly AttachedTextFile[]): string[] {
  return files
    .filter((f): f is Extract<AttachedTextFile, { mode: 'staged' }> => f.mode === 'staged')
    .map((f) => f.stagedId);
}

function nonEmpty<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

export interface PromptPayload {
  prompt: string;
  images: ImageAttachment[] | undefined;
  fileReferences: FileRef[] | undefined;
  symbolReferences: SymbolRef[] | undefined;
  stagedUploads: string[] | undefined;
  attachedFileNames: string[] | undefined;
}

export function buildPromptPayload(
  serialized: SerializedPrompt,
  images: ImageAttachment[],
  textFiles: readonly AttachedTextFile[],
): PromptPayload {
  return {
    prompt: withInlineFiles(textFiles, serialized.text),
    images: nonEmpty(images),
    fileReferences: nonEmpty([...serialized.fileReferences, ...collectUploadedRefs(textFiles)]),
    symbolReferences: nonEmpty(serialized.symbolReferences),
    stagedUploads: nonEmpty(collectStagedIds(textFiles)),
    attachedFileNames: nonEmpty(
      textFiles.filter((f) => f.mode === 'upload' || f.mode === 'staged').map((f) => f.name),
    ),
  };
}

export interface TemplateSelection {
  isDeepAgent: boolean;
  selectedTemplateId: string | undefined;
  templateVars: readonly TemplateVariable[];
  templateVarValues: Record<string, string>;
}

function resolveTemplateVariables(
  selection: TemplateSelection,
): Record<string, string> | undefined {
  const { isDeepAgent, selectedTemplateId, templateVars, templateVarValues } = selection;
  if (!isDeepAgent || !selectedTemplateId || templateVars.length === 0) return undefined;
  return Object.fromEntries(
    templateVars.map((v) => [v.name, templateVarValues[v.name] || v.defaultValue || '']),
  );
}

export interface ThreadOptionsInput extends TemplateSelection {
  isNewThread: boolean;
  threadMode: 'local' | 'worktree';
  runtime: string;
  selectedBranch: string;
  sendToBacklog: boolean;
  followUpSelectedBranch: string;
}

/** Options that differ between a new thread and a follow-up message. */
export function buildThreadOptions(
  input: ThreadOptionsInput,
): Omit<PromptSubmitOptions, 'model' | 'mode'> {
  if (!input.isNewThread) return { baseBranch: input.followUpSelectedBranch || undefined };
  return {
    threadMode: input.threadMode,
    ...parseRuntimeChoice(input.runtime),
    baseBranch: input.selectedBranch || undefined,
    sendToBacklog: input.sendToBacklog,
    agentTemplateId: input.isDeepAgent ? input.selectedTemplateId : undefined,
    templateVariables: resolveTemplateVariables(input),
  };
}
