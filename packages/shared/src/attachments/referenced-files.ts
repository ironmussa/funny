/**
 * Codec for the `<referenced-files>` block that carries attached / mentioned
 * files at the start of a user prompt. This module is the ONLY place that
 * knows the wire format: the client (inline attachments, optimistic
 * messages), the runtime (uploaded/mentioned files, persisted messages) and
 * the UI parser all go through it, so a prompt always carries a single block.
 *
 *   <referenced-files>
 *   <file path="a.md">
 *   …contents…
 *   </file>
 *   <file path="b.pdf" note="Use the Read tool" />
 *   <folder path="src">
 *   <file path="src/x.ts">…</file>
 *   </folder>
 *   </referenced-files>
 *
 *   prompt body
 */

export interface ReferencedFile {
  type: 'file';
  path: string;
  note?: string;
  /** Inlined contents. Omitted for path-only references. */
  content?: string;
}

export interface ReferencedFolder {
  type: 'folder';
  path: string;
  note?: string;
  /** Inlined direct children. Omitted for path-only references. */
  children?: ReferencedFile[];
}

export type ReferencedEntry = ReferencedFile | ReferencedFolder;

export interface ParsedReferencedFiles {
  /** Top-level entries of every leading block, in order. */
  entries: ReferencedEntry[];
  /** The prompt with the leading block(s) and surrounding whitespace removed. */
  body: string;
}

const OPEN = '<referenced-files>';
const CLOSE = '</referenced-files>';

// ── Serialize ────────────────────────────────────────────────

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function attrs(entry: { path: string; note?: string }): string {
  const note = entry.note === undefined ? '' : ` note="${escapeAttr(entry.note)}"`;
  return `path="${escapeAttr(entry.path)}"${note}`;
}

function serializeFile(file: ReferencedFile): string {
  if (file.content === undefined) return `<file ${attrs(file)} />`;
  return `<file ${attrs(file)}>\n${file.content}\n</file>`;
}

function serializeEntry(entry: ReferencedEntry): string {
  if (entry.type === 'file') return serializeFile(entry);
  const children = entry.children ?? [];
  if (children.length === 0) return `<folder ${attrs(entry)}></folder>`;
  return `<folder ${attrs(entry)}>\n${children.map(serializeFile).join('\n')}\n</folder>`;
}

/** Build a prompt with one leading block. Returns `body` unchanged when there are no entries. */
export function serializeReferencedFiles(
  entries: readonly ReferencedEntry[],
  body: string,
): string {
  if (entries.length === 0) return body;
  const block = `${OPEN}\n${entries.map(serializeEntry).join('\n')}\n${CLOSE}`;
  return body ? `${block}\n\n${body}` : block;
}

// ── Parse ────────────────────────────────────────────────────

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function readAttrs(raw: string): { path: string; note?: string } | null {
  const found: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w-]+)="([^"]*)"/g)) found[m[1]] = unescapeAttr(m[2]);
  if (!found.path) return null;
  return found.note === undefined ? { path: found.path } : { path: found.path, note: found.note };
}

/** Strip the single newline the serializer puts around inlined contents. */
function trimContent(raw: string): string {
  return raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

const TAG_RE = /<(file|folder)\b([^>]*?)(\/?)>/y;

interface Cursor {
  text: string;
  pos: number;
}

function skipWhitespace(c: Cursor): void {
  while (c.pos < c.text.length && /\s/.test(c.text[c.pos])) c.pos++;
}

/** Read one `<file>`; contents run to the first `</file>`. */
function readFile(c: Cursor, raw: string, selfClosing: boolean): ReferencedFile | null {
  const meta = readAttrs(raw);
  if (selfClosing) return meta && { type: 'file', ...meta };
  const end = c.text.indexOf('</file>', c.pos);
  if (end < 0) return null;
  const content = c.text.slice(c.pos, end);
  c.pos = end + '</file>'.length;
  if (!meta) return null;
  // `<file path="x"></file>` (empty) is a path-only reference.
  return content === ''
    ? { type: 'file', ...meta }
    : { type: 'file', ...meta, content: trimContent(content) };
}

/** Read `<file>` children up to `</folder>`; null when the folder is malformed. */
function readFolderChildren(c: Cursor): ReferencedFile[] | null {
  const children: ReferencedFile[] = [];
  for (skipWhitespace(c); !c.text.startsWith('</folder>', c.pos); skipWhitespace(c)) {
    TAG_RE.lastIndex = c.pos;
    const m = TAG_RE.exec(c.text);
    if (!m || m[1] !== 'file') return null;
    c.pos = TAG_RE.lastIndex;
    const child = readFile(c, m[2], m[3] === '/');
    if (child) children.push(child);
  }
  c.pos += '</folder>'.length;
  return children;
}

/** Read one `<folder>` and its direct `<file>` children. */
function readFolder(c: Cursor, raw: string, selfClosing: boolean): ReferencedFolder | null {
  const meta = readAttrs(raw);
  if (selfClosing) return meta && { type: 'folder', ...meta };
  const children = readFolderChildren(c);
  if (!children || !meta) return null;
  return children.length > 0 ? { type: 'folder', ...meta, children } : { type: 'folder', ...meta };
}

/**
 * Parse one block starting at `c.pos` (which points at `<referenced-files>`).
 * Entries are tokenized one by one, so inlined contents that contain a literal
 * `</referenced-files>` do not end the block early. Unknown markup inside the
 * block is skipped up to the closing tag. Returns null when the block is
 * unterminated.
 */
function readBlock(c: Cursor): ReferencedEntry[] | null {
  c.pos += OPEN.length;
  const entries: ReferencedEntry[] = [];
  for (;;) {
    skipWhitespace(c);
    if (c.text.startsWith(CLOSE, c.pos)) {
      c.pos += CLOSE.length;
      return entries;
    }
    TAG_RE.lastIndex = c.pos;
    const m = TAG_RE.exec(c.text);
    if (!m) {
      const end = c.text.indexOf(CLOSE, c.pos);
      if (end < 0) return null;
      c.pos = end + CLOSE.length;
      return entries;
    }
    c.pos = TAG_RE.lastIndex;
    const selfClosing = m[3] === '/';
    const entry =
      m[1] === 'file' ? readFile(c, m[2], selfClosing) : readFolder(c, m[2], selfClosing);
    if (!entry) return null;
    entries.push(entry);
  }
}

/** Parse every consecutive `<referenced-files>` block at the start of `text`. */
export function parseReferencedFiles(text: string): ParsedReferencedFiles {
  const c: Cursor = { text, pos: 0 };
  const entries: ReferencedEntry[] = [];
  let bodyStart = 0;
  for (;;) {
    skipWhitespace(c);
    if (!text.startsWith(OPEN, c.pos)) break;
    const block = readBlock(c);
    if (!block) break;
    entries.push(...block);
    bodyStart = c.pos;
  }
  if (bodyStart === 0) return { entries: [], body: text };
  return { entries, body: text.slice(bodyStart).replace(/^\s+/, '') };
}

// ── Transformations ──────────────────────────────────────────

/** Merge `extra` entries into the prompt's leading block (creating it if needed). */
export function addReferencedEntries(text: string, extra: readonly ReferencedEntry[]): string {
  if (extra.length === 0) return text;
  const { entries, body } = parseReferencedFiles(text);
  return serializeReferencedFiles([...entries, ...extra], body);
}

/** Drop inlined contents, keeping path/note references — used for persisted messages. */
export function stripReferencedContents(text: string): string {
  const { entries, body } = parseReferencedFiles(text);
  if (entries.length === 0) return text;
  const pathOnly = entries.map((e): ReferencedEntry => ({
    type: e.type,
    path: e.path,
    ...(e.note !== undefined && { note: e.note }),
  }));
  return serializeReferencedFiles(pathOnly, body);
}
