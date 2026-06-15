import { Download, FileQuestion } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { ImageZoomControls } from '@/components/ImageZoomControls';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { useImageZoomPan } from '@/hooks/use-image-zoom-pan';
import { createClientLogger } from '@/lib/client-logger';
import { markdownProseClassName } from '@/lib/markdown-components';
import { cn } from '@/lib/utils';
import {
  EDITOR_FONT_SIZE_PX,
  PROSE_FONT_SIZE_PX,
  PROSE_LINE_HEIGHT_PX,
  useSettingsStore,
} from '@/stores/settings-store';

const log = createClientLogger('media-preview');

export type MediaKind = 'image' | 'audio' | 'video' | 'pdf' | 'markdown' | 'text' | 'unknown';

const EXT_TO_KIND: Record<string, MediaKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  avif: 'image',
  ico: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  flac: 'audio',
  m4a: 'audio',
  aac: 'audio',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  txt: 'text',
  log: 'text',
  json: 'text',
  yaml: 'text',
  yml: 'text',
  csv: 'text',
  tsv: 'text',
  xml: 'text',
  ini: 'text',
  toml: 'text',
};

/**
 * True if the given file name has an extension we want to render in
 * `MediaPreview` instead of a code editor (image, audio, video, PDF).
 * Markdown and plain text are intentionally excluded — those open in Monaco.
 */
export function isMediaFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext) return false;
  const kind = EXT_TO_KIND[ext];
  return kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf';
}

export function detectMediaKind(name?: string, mime?: string): MediaKind {
  return detectKind(name, mime);
}

function detectKind(name?: string, mime?: string): MediaKind {
  if (mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/pdf') return 'pdf';
    if (mime === 'text/markdown') return 'markdown';
    if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  }
  if (name) {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext && EXT_TO_KIND[ext]) return EXT_TO_KIND[ext];
  }
  return 'unknown';
}

export interface MediaPreviewProps {
  /** URL to the media resource. */
  src: string;
  /** Filename used for display and extension-based type detection. */
  name?: string;
  /** Optional explicit MIME type. Takes priority over extension. */
  mime?: string;
  /** Optional inline text (skips fetching for text/markdown). */
  text?: string;
  /** Force a specific kind (overrides auto-detection). */
  kind?: MediaKind;
  className?: string;
  /** Called when the underlying resource fails to load. */
  onError?: (error: Error) => void;
}

export function MediaPreview({
  src,
  name,
  mime,
  text,
  kind: kindOverride,
  className,
  onError,
}: MediaPreviewProps) {
  const kind = useMemo(() => kindOverride ?? detectKind(name, mime), [kindOverride, name, mime]);

  return (
    <div
      data-testid="media-preview"
      data-media-kind={kind}
      className={cn('flex w-full flex-col overflow-hidden rounded-lg border bg-card', className)}
    >
      <MediaBody kind={kind} src={src} name={name} text={text} onError={onError} />
    </div>
  );
}

function MediaBody({
  kind,
  src,
  name,
  text,
  onError,
}: {
  kind: MediaKind;
  src: string;
  name?: string;
  text?: string;
  onError?: (error: Error) => void;
}) {
  switch (kind) {
    case 'image':
      return <ImagePreview src={src} name={name} onError={onError} />;
    case 'audio':
      return <AudioPreview src={src} name={name} onError={onError} />;
    case 'video':
      return <VideoPreview src={src} name={name} onError={onError} />;
    case 'pdf':
      return <PdfPreview src={src} name={name} />;
    case 'markdown':
      return <MarkdownPreview src={src} text={text} onError={onError} />;
    case 'text':
      return <TextPreview src={src} text={text} onError={onError} />;
    default:
      return <UnknownPreview src={src} name={name} />;
  }
}

function ImagePreview({
  src,
  name,
  onError,
}: {
  src: string;
  name?: string;
  onError?: (error: Error) => void;
}) {
  const zoom = useImageZoomPan();
  return (
    <div
      data-testid="media-preview-image"
      className="bg-muted/30 relative flex max-h-[70vh] min-h-[12rem] items-center justify-center overflow-hidden p-2"
    >
      <img
        {...zoom.imgProps}
        src={src}
        alt={name ?? 'preview'}
        loading="lazy"
        onError={() => onError?.(new Error(`Failed to load image: ${src}`))}
        className={cn(
          'max-h-[66vh] max-w-full rounded object-contain select-none',
          zoom.zoomed ? (zoom.dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
          zoom.dragging ? '' : 'transition-transform duration-150',
        )}
      />
      <ImageZoomControls zoom={zoom} className="absolute bottom-3 left-1/2 -translate-x-1/2" />
    </div>
  );
}

function AudioPreview({
  src,
  name,
  onError,
}: {
  src: string;
  name?: string;
  onError?: (error: Error) => void;
}) {
  return (
    <div className="flex flex-col gap-2 p-3">
      {name && <div className="text-muted-foreground truncate text-sm">{name}</div>}
      <audio
        controls
        src={src}
        data-testid="media-preview-audio"
        onError={() => onError?.(new Error(`Failed to load audio: ${src}`))}
        className="w-full"
      >
        Your browser does not support the audio element.
      </audio>
    </div>
  );
}

function VideoPreview({
  src,
  name,
  onError,
}: {
  src: string;
  name?: string;
  onError?: (error: Error) => void;
}) {
  return (
    <video
      controls
      src={src}
      data-testid="media-preview-video"
      onError={() => onError?.(new Error(`Failed to load video: ${src}`))}
      className="max-h-[70vh] w-full bg-gray-950"
    >
      {name && <track kind="metadata" label={name} />}
      Your browser does not support the video element.
    </video>
  );
}

function PdfPreview({ src, name }: { src: string; name?: string }) {
  return (
    <iframe
      src={src}
      title={name ?? 'PDF preview'}
      data-testid="media-preview-pdf"
      className="h-[70vh] w-full"
    />
  );
}

function useTextResource(src: string, inline?: string, onError?: (e: Error) => void) {
  const [content, setContent] = useState<string | null>(inline ?? null);
  const [loading, setLoading] = useState(inline === undefined);

  useEffect(() => {
    if (inline !== undefined) {
      setContent(inline);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((body) => {
        if (cancelled) return;
        setContent(body);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        log.error('Failed to fetch text resource', { src, error: err.message });
        setLoading(false);
        onError?.(err);
      });
    return () => {
      cancelled = true;
    };
  }, [src, inline, onError]);

  return { content, loading };
}

function MarkdownPreview({
  src,
  text,
  onError,
}: {
  src: string;
  text?: string;
  onError?: (error: Error) => void;
}) {
  const fontSize = useSettingsStore((s) => s.fontSize);
  const { content, loading } = useTextResource(src, text, onError);

  if (loading) return <PreviewSpinner />;
  if (content === null) return <PreviewError />;

  return (
    <div
      data-testid="media-preview-markdown"
      className={cn(markdownProseClassName, 'p-4')}
      style={{
        fontSize: PROSE_FONT_SIZE_PX[fontSize],
        lineHeight: `${PROSE_LINE_HEIGHT_PX[fontSize]}px`,
      }}
    >
      {/* Security ME-9: rehypeSanitize is mandatory on every ReactMarkdown sink
       *  (MessageContent.tsx documents the policy). Without it, raw HTML in a
       *  previewed file would render — react-markdown defaults to escaping it,
       *  but the policy is explicit and any future plugin that enables raw
       *  HTML (rehype-raw) would silently turn this into an XSS sink.
       */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function TextPreview({
  src,
  text,
  onError,
}: {
  src: string;
  text?: string;
  onError?: (error: Error) => void;
}) {
  const fontSize = useSettingsStore((s) => s.fontSize);
  const { content, loading } = useTextResource(src, text, onError);

  if (loading) return <PreviewSpinner />;
  if (content === null) return <PreviewError />;

  return (
    <pre
      data-testid="media-preview-text"
      className="text-foreground m-0 max-h-[70vh] overflow-auto p-4 font-mono wrap-break-word whitespace-pre-wrap"
      style={{ fontSize: EDITOR_FONT_SIZE_PX[fontSize] }}
    >
      {content}
    </pre>
  );
}

function UnknownPreview({ src, name }: { src: string; name?: string }) {
  return (
    <div
      data-testid="media-preview-unknown"
      className="flex flex-col items-center gap-3 p-6 text-center"
    >
      <FileQuestion className="icon-xl text-muted-foreground" />
      <div className="text-muted-foreground text-sm">
        No preview available{name ? ` for ${name}` : ''}.
      </div>
      <Button asChild variant="outline" size="sm" data-testid="media-preview-download">
        <a href={src} download={name} target="_blank" rel="noreferrer">
          <Download className="icon-sm" />
          Download
        </a>
      </Button>
    </div>
  );
}

function PreviewSpinner() {
  return (
    <LoadingState fill={false} size="compact" className="p-6" testId="media-preview-loading" />
  );
}

function PreviewError() {
  return (
    <div className="text-destructive p-6 text-sm" data-testid="media-preview-error">
      Failed to load preview.
    </div>
  );
}
