/**
 * Image + file attachment state for PromptInputUI.
 *
 * Browsers do not expose absolute paths for dropped files, so we cannot
 * send a path the runtime can resolve. `classifyAttachment`
 * (@funny/shared/attachments) picks the kind and one handler per kind
 * applies it:
 *   - image: model-supported image formats, sent as image blocks.
 *   - inline-text: small text files, contents embedded in the prompt.
 *   - upload: everything else up to uploadMaxBytes — POST to
 *     /threads/:id/upload, which writes the file under
 *     .funny/uploads/<threadId>/ on the runner; we then send the path as a
 *     fileReference and the agent reads on demand. Before the thread exists
 *     (first message) the file is staged via /uploads/staging instead and
 *     adopted into the thread on creation.
 *   - reject (size > uploadMaxBytes): toast error.
 *
 * Limits per provider live in PROVIDER_ATTACHMENT_LIMITS (@funny/shared/models).
 */
import type { ImageAttachment } from '@funny/shared';
import {
  attachmentTextHint,
  classifyAttachment,
  looksLikeText,
  type AttachmentKind,
} from '@funny/shared/attachments';
import type { AttachmentLimits } from '@funny/shared/models';
import { getAttachmentLimits } from '@funny/shared/models';
import type { TFunction } from 'i18next';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { threadsApi } from '@/lib/api/threads';

import type { AttachedTextFile } from './prompt-submit';

type SetTextFiles = React.Dispatch<React.SetStateAction<AttachedTextFile[]>>;

const MB = 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function readImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      const mediaType = file.type as ImageAttachment['source']['media_type'];
      resolve({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Inline tier: small enough to embed directly in the prompt. */
async function addInlineFile(file: File, setFiles: SetTextFiles, t: TFunction): Promise<void> {
  try {
    const content = await file.text();
    setFiles((prev) => [...prev, { mode: 'inline', name: file.name, content, size: file.size }]);
  } catch {
    toast.error(
      t('prompt.fileReadError', { defaultValue: 'Could not read {{name}}', name: file.name }),
    );
  }
}

function toastUploadError(t: TFunction, name: string, error: string) {
  toast.error(
    t('prompt.fileUploadError', {
      defaultValue: 'Upload failed for {{name}}: {{error}}',
      name,
      error,
    }),
  );
}

interface UploadContext {
  /** Existing thread → upload into it; absent → stage for the thread being created. */
  threadId?: string;
  /** Routes a staged upload to the project's runner (absent for scratch). */
  projectId?: string;
  provider: string;
  setFiles: SetTextFiles;
  t: TFunction;
}

type UploadedFile = Exclude<AttachedTextFile, { mode: 'inline' } | { mode: 'uploading' }>;

/** Send the file to the thread, or to the staging area when there is no thread yet. */
async function sendUpload(
  file: File,
  contentBase64: string,
  ctx: UploadContext,
): Promise<{ ok: true; value: UploadedFile } | { ok: false; error: string }> {
  const body = { provider: ctx.provider, filename: file.name, contentBase64 };
  if (ctx.threadId) {
    const result = await threadsApi.uploadFile(ctx.threadId, body);
    return result.isErr()
      ? { ok: false, error: result.error.message }
      : { ok: true, value: { mode: 'upload', name: file.name, ...result.value } };
  }
  const result = await threadsApi.stageUpload(body, ctx.projectId);
  return result.isErr()
    ? { ok: false, error: result.error.message }
    : {
        ok: true,
        value: {
          mode: 'staged',
          name: file.name,
          stagedId: result.value.stagedId,
          size: result.value.size,
        },
      };
}

/** Upload tier: shows an "uploading" chip, then swaps it for the uploaded/staged file. */
async function uploadLargeFile(file: File, ctx: UploadContext): Promise<void> {
  const { setFiles, t } = ctx;
  const tempKey = `${file.name}__${Date.now()}__${Math.random()}`;
  const isTemp = (f: AttachedTextFile) => f.mode === 'uploading' && f.name === tempKey;
  const dropTemp = () => setFiles((prev) => prev.filter((f) => !isTemp(f)));

  setFiles((prev) => [...prev, { mode: 'uploading', name: tempKey, size: file.size }]);
  try {
    const result = await sendUpload(file, await fileToBase64(file), ctx);
    if (!result.ok) {
      dropTemp();
      toastUploadError(t, file.name, result.error);
      return;
    }
    setFiles((prev) => prev.map((f) => (isTemp(f) ? result.value : f)));
  } catch (e) {
    dropTemp();
    toastUploadError(t, file.name, e instanceof Error ? e.message : String(e));
  }
}

const SNIFF_BYTES = 8192;

/** Only small files with an inconclusive name/MIME need their bytes sniffed. */
async function sniffIsText(file: File, limits: AttachmentLimits): Promise<boolean | undefined> {
  if (file.size > limits.inlineMaxBytes) return undefined;
  if (attachmentTextHint(file) !== 'unknown') return undefined;
  const sample = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  return looksLikeText(sample);
}

interface AttachmentContext {
  limits: AttachmentLimits;
  provider: string;
  threadId?: string;
  projectId?: string;
  t: TFunction;
  setImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  setFiles: SetTextFiles;
}

type AttachmentHandler = (file: File, ctx: AttachmentContext) => Promise<void>;

/** One strategy per attachment kind; adding a kind without a handler fails to compile. */
const ATTACHMENT_HANDLERS: Record<AttachmentKind, AttachmentHandler> = {
  reject: async (file, { limits, t }) => {
    toast.error(
      t('prompt.fileTooLarge', {
        defaultValue: '{{name}} is too large ({{size}} MB). Max {{max}} MB.',
        name: file.name,
        size: (file.size / MB).toFixed(1),
        max: (limits.uploadMaxBytes / MB).toFixed(0),
      }),
    );
  },
  image: async (file, { setImages }) => {
    const image = await readImageAttachment(file);
    setImages((prev) => [...prev, image]);
  },
  'inline-text': (file, { setFiles, t }) => addInlineFile(file, setFiles, t),
  upload: (file, { threadId, projectId, provider, setFiles, t }) =>
    uploadLargeFile(file, { threadId, projectId, provider, setFiles, t }),
};

interface UsePromptAttachmentsParams {
  initialImages?: ImageAttachment[];
  provider: string;
  threadId?: string;
  /** Project of the thread being created — routes staged uploads to its runner. */
  projectId?: string;
  t: TFunction;
}

export function usePromptAttachments({
  initialImages,
  provider,
  threadId,
  projectId,
  t,
}: UsePromptAttachmentsParams) {
  const [images, setImages] = useState<ImageAttachment[]>(initialImages ?? []);
  const [attachedTextFiles, setAttachedTextFiles] = useState<AttachedTextFile[]>([]);

  const attachmentLimits = useMemo(
    () => getAttachmentLimits(provider as Parameters<typeof getAttachmentLimits>[0]),
    [provider],
  );

  /** Classify one file and hand it to the matching strategy. */
  const addFile = useCallback(
    async (file: File): Promise<void> => {
      const isText = await sniffIsText(file, attachmentLimits).catch(() => undefined);
      const kind = classifyAttachment(
        { name: file.name, type: file.type, size: file.size, isText },
        attachmentLimits,
      );
      await ATTACHMENT_HANDLERS[kind](file, {
        limits: attachmentLimits,
        provider,
        threadId,
        projectId,
        t,
        setImages,
        setFiles: setAttachedTextFiles,
      });
    },
    [attachmentLimits, provider, projectId, t, threadId],
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const removeTextFile = useCallback((index: number) => {
    setAttachedTextFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /** Adds dropped/selected files one at a time. */
  const addFiles = useCallback(
    async (files: FileList) => {
      for (const file of Array.from(files)) await addFile(file);
    },
    [addFile],
  );

  return {
    images,
    setImages,
    attachedTextFiles,
    setAttachedTextFiles,
    addFile,
    removeImage,
    removeTextFile,
    addFiles,
  };
}
