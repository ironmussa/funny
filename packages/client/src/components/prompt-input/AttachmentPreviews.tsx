import type { ImageAttachment } from '@funny/shared';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AttachmentChip } from '@/components/ui/chip';

import type { AttachedTextFile } from './prompt-submit';

function imageDataUrl(img: ImageAttachment): string {
  return `data:${img.source.media_type};base64,${img.source.data}`;
}

export function toLightboxImages(images: ImageAttachment[]) {
  return images.map((img, idx) => ({ src: imageDataUrl(img), alt: `Attachment ${idx + 1}` }));
}

interface ImagePreviewsProps {
  images: ImageAttachment[];
  loading: boolean;
  onPreview: (index: number) => void;
  onRemove: (index: number) => void;
}

export function ImagePreviews({ images, loading, onPreview, onRemove }: ImagePreviewsProps) {
  const { t } = useTranslation();
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {images.map((img, idx) => (
        <div key={`${img.source.media_type}-${img.source.data}`} className="group relative">
          <button
            type="button"
            aria-label={`Preview attachment ${idx + 1}`}
            onClick={() => onPreview(idx)}
          >
            <img
              src={imageDataUrl(img)}
              alt={`Attachment ${idx + 1}`}
              className="border-foreground max-h-10 min-h-10 max-w-24 min-w-10 cursor-pointer rounded border-2 object-cover transition-opacity hover:opacity-80"
            />
          </button>
          <button
            onClick={() => onRemove(idx)}
            aria-label={t('prompt.removeImage', 'Remove image')}
            className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 rounded-full p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
            disabled={loading}
          >
            <X className="icon-xs" />
          </button>
        </div>
      ))}
    </div>
  );
}

function formatAttachmentSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(size / 1024) || '<1'} KB`;
}

function attachmentKey(f: AttachedTextFile): string {
  return `${f.name}-${f.size}-${f.mode}-${f.mode === 'upload' ? f.path : ''}`;
}

function attachmentTitle(f: AttachedTextFile, sizeLabel: string): string {
  return `${f.name} (${sizeLabel})${f.mode === 'upload' ? ` — uploaded to ${f.path}` : ''}`;
}

interface TextFilePreviewsProps {
  files: AttachedTextFile[];
  loading: boolean;
  onRemove: (index: number) => void;
}

export function TextFilePreviews({ files, loading, onRemove }: TextFilePreviewsProps) {
  const { t } = useTranslation();
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {files.map((f, idx) => {
        const isUploading = f.mode === 'uploading';
        const sizeLabel = formatAttachmentSize(f.size);
        return (
          <AttachmentChip
            key={attachmentKey(f)}
            data-testid={`prompt-attached-file-${idx}`}
            name={f.name}
            size={sizeLabel}
            loading={isUploading}
            onRemove={() => onRemove(idx)}
            removeDisabled={loading || isUploading}
            removeLabel={t('prompt.removeFile', 'Remove file')}
            title={attachmentTitle(f, sizeLabel)}
          />
        );
      })}
    </div>
  );
}
