/**
 * Attachment classification: decides how a user-attached file reaches the
 * agent. The policy is an ordered rule table (first match wins) so it reads
 * top-to-bottom and each rule can be tested on its own.
 *
 *   reject       → larger than the provider's upload cap
 *   image        → a format the model accepts as an image block
 *   inline-text  → small text file, contents embedded in the prompt
 *   upload       → everything else (PDF, Office, archives, large text…):
 *                  written to the runner, the agent reads it with Read
 */
import type { AttachmentLimits } from '../provider-types.js';

export type AttachmentKind = 'reject' | 'image' | 'inline-text' | 'upload';

export interface AttachmentFileMeta {
  name: string;
  /** Browser-reported MIME type ('' when unknown). */
  type: string;
  size: number;
  /**
   * Result of content sniffing (`looksLikeText`). Only needed when
   * `attachmentTextHint` is `'unknown'`; otherwise the hint decides.
   */
  isText?: boolean;
}

/** Image formats accepted by the model as image content blocks. */
export const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Extensions win over MIME: browsers report e.g. `.ts` as `video/mp2t` and
// leave many source files with an empty type.
const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown mdx rst adoc csv tsv log json jsonc json5 ndjson yaml yml toml ini cfg conf env ' +
    'xml svg html htm css scss sass less js mjs cjs jsx ts mts cts tsx vue svelte astro ' +
    'py rb php pl lua r go rs java kt kts scala swift c h cc cpp hpp cs fs m mm dart ex exs erl ' +
    'clj hs ml sh bash zsh fish ps1 bat sql graphql gql proto prisma tf hcl dockerfile makefile ' +
    'gradle properties lock diff patch tex bib srt vtt dbml mmd'
  ).split(' '),
);

const BINARY_EXTENSIONS = new Set(
  (
    'pdf doc docx xls xlsx ppt pptx odt ods odp rtf pages numbers key epub zip gz tgz bz2 xz 7z rar ' +
    'tar jar war exe dll so dylib bin wasm sqlite db png jpg jpeg gif webp bmp tif tiff ico heic heif ' +
    'avif psd ai mp3 wav flac ogg m4a aac mp4 mov avi mkv webm woff woff2 ttf otf eot'
  ).split(' '),
);

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-sh',
  'application/sql',
  'application/graphql',
  'image/svg+xml',
]);

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  // Extension-less names (Dockerfile, Makefile) are matched by basename.
  return (dot > 0 ? base.slice(dot + 1) : base).toLowerCase();
}

/** Cheap text/binary guess from name + MIME. `'unknown'` means "sniff the bytes". */
export function attachmentTextHint(
  meta: Pick<AttachmentFileMeta, 'name' | 'type'>,
): 'text' | 'binary' | 'unknown' {
  const ext = extensionOf(meta.name);
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';
  const mime = meta.type.toLowerCase();
  if (mime.startsWith('text/') || TEXT_MIME_TYPES.has(mime)) return 'text';
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return 'text';
  if (mime && mime !== 'application/octet-stream') return 'binary';
  return 'unknown';
}

/**
 * Content sniff for files whose name/MIME are inconclusive: text when the
 * sample has no NUL byte and is valid UTF-8 (a multi-byte sequence cut at the
 * end of the sample is tolerated).
 */
export function looksLikeText(sample: Uint8Array): boolean {
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function isText(meta: AttachmentFileMeta): boolean {
  const hint = attachmentTextHint(meta);
  return hint === 'unknown' ? meta.isText === true : hint === 'text';
}

interface Rule {
  kind: AttachmentKind;
  when: (meta: AttachmentFileMeta, limits: AttachmentLimits) => boolean;
}

const RULES: readonly Rule[] = [
  { kind: 'reject', when: (m, l) => m.size > l.uploadMaxBytes },
  { kind: 'image', when: (m) => MODEL_IMAGE_TYPES.has(m.type.toLowerCase()) },
  { kind: 'inline-text', when: (m, l) => m.size <= l.inlineMaxBytes && isText(m) },
  { kind: 'upload', when: () => true },
];

export function classifyAttachment(
  meta: AttachmentFileMeta,
  limits: AttachmentLimits,
): AttachmentKind {
  return RULES.find((rule) => rule.when(meta, limits))!.kind;
}
