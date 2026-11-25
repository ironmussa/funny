import { isMarkdownFile } from '@/lib/markdown-file';

export type MediaKind = 'image' | 'audio' | 'video' | 'pdf' | 'markdown' | 'text' | 'unknown';

/** Media kinds, keyed by lower-case file extension. */
const EXT_TO_KIND = new Map<string, MediaKind>(
  Object.entries({
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
  } satisfies Record<string, MediaKind>),
);

/** True for media that opens outside the code editor. */
export function isMediaFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext) return false;
  const kind = EXT_TO_KIND.get(ext);
  return kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf';
}

export function detectMediaKind(name?: string, mime?: string): MediaKind {
  if (mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/pdf') return 'pdf';
    if (mime === 'text/markdown') return 'markdown';
    if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  }
  if (name) {
    if (isMarkdownFile(name)) return 'markdown';
    const ext = name.split('.').pop()?.toLowerCase();
    const kind = ext ? EXT_TO_KIND.get(ext) : undefined;
    if (kind) return kind;
  }
  return 'unknown';
}
