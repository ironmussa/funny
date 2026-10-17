/**
 * Pure helpers for the PromptInputUI submit pipeline: attachment shaping,
 * provider-setup gating and the `onSubmit` option payload.
 */
import type { ImageAttachment, TemplateVariable } from '@funny/shared';

import type { FileRef, SymbolRef } from '@/lib/thread-payload';

/**
 * Attached files: small files are inlined (`mode: 'inline'`, content is
 * embedded in the prompt on submit); larger files are uploaded to the
 * runner (`mode: 'upload'`, sent as a fileReference for the server to
 * resolve on disk). `mode: 'uploading'` marks an upload in flight.
 */
export type AttachedTextFile =
  | { mode: 'inline'; name: string; content: string; size: number }
  | { mode: 'upload'; name: string; path: string; size: number }
  | { mode: 'uploading'; name: string; size: number };

export interface PromptSubmitOptions {
  provider?: string;
  model: string;
  mode: string;
  effort?: string;
  threadMode?: string;
  runtime?: string;
  baseBranch?: string;
  cwd?: string;
  sendToBacklog?: boolean;
  fileReferences?: FileRef[];
  symbolReferences?: SymbolRef[];
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
 * Inline-tier files: embed contents in a <referenced-files> block prepended
 * to the prompt (browsers can't expose paths for these small dropped files).
 */
function buildInlineFilesBlock(files: readonly AttachedTextFile[]): string {
  const inlineFiles = files.filter(
    (f): f is Extract<AttachedTextFile, { mode: 'inline' }> => f.mode === 'inline',
  );
  if (inlineFiles.length === 0) return '';
  const body = inlineFiles
    .map((f) => `<file path="${f.name.replace(/"/g, '&quot;')}">\n${f.content}\n</file>`)
    .join('\n');
  return `<referenced-files>\n${body}\n</referenced-files>\n\n`;
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

function nonEmpty<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

export interface PromptPayload {
  prompt: string;
  images: ImageAttachment[] | undefined;
  fileReferences: FileRef[] | undefined;
  symbolReferences: SymbolRef[] | undefined;
}

export function buildPromptPayload(
  serialized: SerializedPrompt,
  images: ImageAttachment[],
  textFiles: readonly AttachedTextFile[],
): PromptPayload {
  return {
    prompt: buildInlineFilesBlock(textFiles) + serialized.text,
    images: nonEmpty(images),
    fileReferences: nonEmpty([...serialized.fileReferences, ...collectUploadedRefs(textFiles)]),
    symbolReferences: nonEmpty(serialized.symbolReferences),
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
    runtime: input.runtime,
    baseBranch: input.selectedBranch || undefined,
    sendToBacklog: input.sendToBacklog,
    agentTemplateId: input.isDeepAgent ? input.selectedTemplateId : undefined,
    templateVariables: resolveTemplateVariables(input),
  };
}
