/**
 * Submit pipeline for PromptInputUI. Each guard is its own step so the
 * orchestration in {@link submitPrompt} reads top to bottom:
 * empty check → Codex command → provider setup → thread mode → checkout
 * preflight → upload guard → optimistic clear + onSubmit (restored on `false`).
 */
import type { ImageAttachment, TemplateVariable } from '@funny/shared';
import { parseCodexCommand } from '@funny/shared/codex-commands';
import type { TFunction } from 'i18next';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { toast } from 'sonner';

import type {
  PromptEditorHandle,
  PromptSlashResource,
} from '@/components/prompt-editor/PromptEditor';
import { serializeEditorContent } from '@/components/prompt-editor/serialize';
import { systemApi } from '@/lib/api/system';
import { getLeadingSlashCommand, resolveSlashCommandThreadMode } from '@/lib/thread-payload';

import {
  EMPTY_SERIALIZED_PROMPT,
  buildPromptPayload,
  buildThreadOptions,
  hasPromptAttachments,
  isUploadInFlight,
  providerNeedsSetup,
  type AttachedTextFile,
  type PromptSubmitOptions,
  type SerializedPrompt,
} from './prompt-submit';

type EditorJSON = ReturnType<PromptEditorHandle['getJSON']>;
type ThreadMode = 'local' | 'worktree';

export type PromptOnSubmit = (
  prompt: string,
  opts: PromptSubmitOptions,
  images?: ImageAttachment[],
) => Promise<boolean | void> | boolean | void;

export interface PromptSubmitParams {
  t: TFunction;
  editorRef: React.RefObject<PromptEditorHandle | null>;
  onSubmit: PromptOnSubmit;
  loading: boolean;
  running: boolean;
  isRecording: boolean;
  onStopRecording?: () => void;
  provider: string;
  model: string;
  mode: string;
  effort?: string;
  runtime: string;
  projectId?: string;
  sendToBacklog: boolean;
  isNewThread: boolean;
  isScratch: boolean;
  createWorktree: boolean;
  selectedBranch: string;
  followUpSelectedBranch: string;
  loadSkills?: () => Promise<PromptSlashResource[]>;
  onCheckoutPreflight?: (branch: string) => Promise<boolean>;
  executeCodexCommand: (text: string) => Promise<boolean>;
  images: ImageAttachment[];
  setImages: (images: ImageAttachment[]) => void;
  attachedTextFiles: AttachedTextFile[];
  setAttachedTextFiles: (files: AttachedTextFile[]) => void;
  setEditorEmpty: (empty: boolean) => void;
  setNeedsProviderSetup: (open: boolean) => void;
  isDeepAgent: boolean;
  selectedTemplateId: string | undefined;
  templateVars: readonly TemplateVariable[];
  templateVarValues: Record<string, string>;
}

type StepOutcome = 'stop' | 'continue';

/** Runs a Codex slash command locally when the provider supports it. */
async function tryCodexCommand(
  p: PromptSubmitParams,
  serialized: SerializedPrompt,
): Promise<StepOutcome> {
  if (p.provider !== 'codex' || !parseCodexCommand(serialized.text)) return 'continue';
  if (hasPromptAttachments(serialized, p.images.length, p.attachedTextFiles.length)) {
    toast.error('Send attachments in a separate message from Codex commands.');
    return 'stop';
  }
  try {
    if (!(await p.executeCodexCommand(serialized.text))) return 'continue';
    p.editorRef.current?.clear();
    p.setEditorEmpty(true);
    return 'stop';
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Codex command failed');
    return 'stop';
  }
}

/** Opens the provider setup dialog instead of sending when the provider is not ready. */
async function ensureProviderReady(
  p: PromptSubmitParams,
  checking: React.RefObject<boolean>,
): Promise<boolean> {
  if (p.running || p.sendToBacklog || !p.projectId) return true;
  if (checking.current) return false;
  checking.current = true;
  try {
    const setup = await systemApi.providerSetupStatus(p.provider, p.projectId);
    if (setup.isErr()) {
      toast.error(setup.error.message);
      return false;
    }
    if (providerNeedsSetup(p.provider, setup.value)) {
      p.setNeedsProviderSetup(true);
      return false;
    }
    return true;
  } finally {
    checking.current = false;
  }
}

/** A leading slash command may force a thread mode for new (non-scratch) threads. */
async function resolveThreadMode(p: PromptSubmitParams, text: string): Promise<ThreadMode> {
  const leadingSlashCommand = getLeadingSlashCommand(text);
  const slashResources = leadingSlashCommand && p.loadSkills ? await p.loadSkills() : undefined;
  const commandThreadMode =
    p.isNewThread && !p.isScratch && leadingSlashCommand && slashResources
      ? resolveSlashCommandThreadMode(text, slashResources)
      : undefined;
  return commandThreadMode ?? (p.createWorktree ? 'worktree' : 'local');
}

/** Checkout preflight for new threads running in local mode. */
async function passesCheckoutPreflight(
  p: PromptSubmitParams,
  threadMode: ThreadMode,
): Promise<boolean> {
  if (!p.isNewThread || threadMode === 'worktree') return true;
  if (!p.onCheckoutPreflight || !p.selectedBranch) return true;
  return p.onCheckoutPreflight(p.selectedBranch);
}

/** Optimistically clears the composer, submits, and restores it on `false`. */
async function sendPrompt(
  p: PromptSubmitParams,
  editorJSON: EditorJSON,
  serialized: SerializedPrompt,
  threadMode: ThreadMode,
): Promise<void> {
  const payload = buildPromptPayload(serialized, p.images, p.attachedTextFiles);
  const submittedTextFiles = p.attachedTextFiles;
  p.editorRef.current?.clear();
  p.setImages([]);
  p.setAttachedTextFiles([]);
  p.setEditorEmpty(true);
  p.editorRef.current?.focus();

  const result = await p.onSubmit(
    payload.prompt,
    {
      provider: p.provider,
      model: p.model,
      mode: p.mode,
      effort: p.effort,
      ...buildThreadOptions({ ...p, threadMode }),
      fileReferences: payload.fileReferences,
      symbolReferences: payload.symbolReferences,
    },
    payload.images,
  );
  if (result !== false) return;
  if (editorJSON) p.editorRef.current?.setContent(editorJSON);
  p.setImages(payload.images ?? []);
  p.setAttachedTextFiles(submittedTextFiles);
}

/** Reads the composer; warns and returns `null` when it is empty. */
function readEditorDraft(
  p: PromptSubmitParams,
): { editorJSON: EditorJSON; serialized: SerializedPrompt } | null {
  const editorJSON = p.editorRef.current?.getJSON();
  if (p.editorRef.current?.isEmpty() ?? true) {
    toast.warning(p.t('prompt.emptyPrompt', 'Please enter a prompt before sending'));
    return null;
  }
  const serialized = editorJSON ? serializeEditorContent(editorJSON) : EMPTY_SERIALIZED_PROMPT;
  return { editorJSON, serialized };
}

/** Block submit while any upload is still in flight. */
function blockedByUpload(p: PromptSubmitParams): boolean {
  if (!isUploadInFlight(p.attachedTextFiles)) return false;
  toast.warning(
    p.t('prompt.uploadInProgress', {
      defaultValue: 'Wait for uploads to finish before sending.',
    }),
  );
  return true;
}

async function submitPrompt(
  p: PromptSubmitParams,
  checkingProvider: React.RefObject<boolean>,
): Promise<void> {
  if (p.loading) return;
  if (p.isRecording) p.onStopRecording?.();

  const draft = readEditorDraft(p);
  if (!draft) return;
  const { editorJSON, serialized } = draft;
  if ((await tryCodexCommand(p, serialized)) === 'stop') return;
  if (!(await ensureProviderReady(p, checkingProvider))) return;
  const threadMode = await resolveThreadMode(p, serialized.text);
  if (!(await passesCheckoutPreflight(p, threadMode))) return;
  if (blockedByUpload(p)) return;

  await sendPrompt(p, editorJSON, serialized, threadMode);
}

/**
 * Returns a stable submit callback that always runs the pipeline against the
 * latest committed params (the editor stores `onSubmit` in a ref anyway).
 */
export function usePromptSubmit(params: PromptSubmitParams): () => Promise<void> {
  const checkingProvider = useRef(false);
  const latestParams = useRef(params);
  useLayoutEffect(() => {
    latestParams.current = params;
  });
  return useCallback(() => submitPrompt(latestParams.current, checkingProvider), []);
}
