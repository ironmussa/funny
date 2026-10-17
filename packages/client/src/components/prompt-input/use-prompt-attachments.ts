/**
 * Image + text-file attachment state for PromptInputUI.
 *
 * Browsers do not expose absolute paths for dropped files, so we cannot
 * send a path the runtime can resolve. Instead we use a tiered strategy:
 *   - inline (size ≤ inlineMaxBytes): read contents and embed in prompt.
 *   - upload (size ≤ uploadMaxBytes): POST to /threads/:id/upload, which
 *     writes the file under .funny/uploads/<threadId>/ on the runner; we
 *     then send the path as a fileReference and the agent reads on demand.
 *   - reject (size > uploadMaxBytes): toast error.
 *
 * Limits per provider live in PROVIDER_ATTACHMENT_LIMITS (@funny/shared/models).
 */
import type { ImageAttachment } from '@funny/shared';
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
  threadId: string;
  provider: string;
  setFiles: SetTextFiles;
  t: TFunction;
}

/** Upload tier: shows an "uploading" chip, then swaps it for the uploaded path. */
async function uploadLargeFile(file: File, ctx: UploadContext): Promise<void> {
  const { threadId, provider, setFiles, t } = ctx;
  const tempKey = `${file.name}__${Date.now()}__${Math.random()}`;
  const isTemp = (f: AttachedTextFile) => f.mode === 'uploading' && f.name === tempKey;
  const dropTemp = () => setFiles((prev) => prev.filter((f) => !isTemp(f)));

  setFiles((prev) => [...prev, { mode: 'uploading', name: tempKey, size: file.size }]);
  try {
    const contentBase64 = await fileToBase64(file);
    const result = await threadsApi.uploadFile(threadId, {
      provider,
      filename: file.name,
      contentBase64,
    });
    if (result.isErr()) {
      dropTemp();
      toastUploadError(t, file.name, result.error.message);
      return;
    }
    const uploaded = result.value;
    setFiles((prev) =>
      prev.map((f) =>
        isTemp(f)
          ? { mode: 'upload', name: file.name, path: uploaded.path, size: uploaded.size }
          : f,
      ),
    );
  } catch (e) {
    dropTemp();
    toastUploadError(t, file.name, e instanceof Error ? e.message : String(e));
  }
}

interface UsePromptAttachmentsParams {
  initialImages?: ImageAttachment[];
  provider: string;
  threadId?: string;
  t: TFunction;
}

export function usePromptAttachments({
  initialImages,
  provider,
  threadId,
  t,
}: UsePromptAttachmentsParams) {
  const [images, setImages] = useState<ImageAttachment[]>(initialImages ?? []);
  const [attachedTextFiles, setAttachedTextFiles] = useState<AttachedTextFile[]>([]);

  const attachmentLimits = useMemo(
    () => getAttachmentLimits(provider as Parameters<typeof getAttachmentLimits>[0]),
    [provider],
  );

  const addImageFile = useCallback(async (file: File): Promise<void> => {
    const image = await readImageAttachment(file);
    setImages((prev) => [...prev, image]);
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addTextFile = useCallback(
    async (file: File): Promise<void> => {
      const { inlineMaxBytes, uploadMaxBytes } = attachmentLimits;

      // Reject: above the upload tier.
      if (file.size > uploadMaxBytes) {
        toast.error(
          t('prompt.fileTooLarge', {
            defaultValue: '{{name}} is too large ({{size}} MB). Max {{max}} MB.',
            name: file.name,
            size: (file.size / MB).toFixed(1),
            max: (uploadMaxBytes / MB).toFixed(0),
          }),
        );
        return;
      }
      if (file.size <= inlineMaxBytes) return addInlineFile(file, setAttachedTextFiles, t);

      // Upload tier: requires an existing thread (path is `.funny/uploads/<threadId>/`).
      if (!threadId) {
        toast.error(
          t('prompt.fileUploadNeedsThread', {
            defaultValue:
              '{{name}} is too large to inline. Send a first message to start the thread, then attach larger files.',
            name: file.name,
          }),
        );
        return;
      }
      return uploadLargeFile(file, { threadId, provider, setFiles: setAttachedTextFiles, t });
    },
    [attachmentLimits, provider, t, threadId],
  );

  const removeTextFile = useCallback((index: number) => {
    setAttachedTextFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /** Adds dropped/selected files one at a time, routing images vs text files. */
  const addFiles = useCallback(
    async (files: FileList) => {
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          await addImageFile(file);
        } else {
          await addTextFile(file);
        }
      }
    },
    [addImageFile, addTextFile],
  );

  return {
    images,
    setImages,
    attachedTextFiles,
    setAttachedTextFiles,
    addImageFile,
    removeImage,
    removeTextFile,
    addFiles,
  };
}
