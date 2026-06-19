import { parseReferencedFiles, type ReferencedItem } from './parse-referenced-files';

/**
 * Strip the leading `<referenced-files>` XML block (added when files are
 * attached via the paperclip) from a thread title and surface the attached
 * file metadata so callers can render a separate attachment indicator.
 *
 * - Title with prompt text + attachments → returns the prompt text.
 * - Title with attachments but no text → returns a file-name preview.
 * - Title with a malformed/unterminated block → falls back to a sanitized
 *   single-line preview so we never render raw XML to users.
 */
export function cleanThreadTitle(title: string): {
  displayTitle: string;
  attachedFiles: ReferencedItem[];
} {
  const { files, cleanContent } = parseReferencedFiles(title);
  const cleaned = cleanContent.trim();
  const containsRawXml = /<referenced-files\b|<file\s+path=/i.test(cleaned);

  if (cleaned && !containsRawXml) {
    return { displayTitle: cleaned, attachedFiles: files };
  }
  if (files.length > 0) {
    const names = files.map((f) => f.path.split('/').pop() || f.path);
    return { displayTitle: names.join(', '), attachedFiles: files };
  }
  // Defensive fallback: title still looks like raw XML (e.g. truncated block
  // missing its closing tag). Strip tags and collapse whitespace so we never
  // render `<referenced-files>` in the UI. Pull out the file path attributes
  // first so we can still surface them as attachments.
  if (containsRawXml || /<referenced-files\b|<file\s+path=/i.test(title)) {
    const recoveredPaths: ReferencedItem[] = [];
    const fileTagRegex = /<file\s+path="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = fileTagRegex.exec(title)) !== null) {
      recoveredPaths.push({ path: m[1], type: 'file' });
    }
    const sanitized = title
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      displayTitle: sanitized || recoveredPaths.map((f) => f.path).join(', ') || title,
      attachedFiles: recoveredPaths.length > 0 ? recoveredPaths : files,
    };
  }
  return { displayTitle: title, attachedFiles: files };
}

/**
 * Detect a leading `/slash-command` at the very start of a (already cleaned)
 * thread title. Returns the command name (without the leading slash) and the
 * remaining title text, so list/card surfaces can render the command as a chip
 * to match how it appears in the main thread's user message.
 *
 * Mirrors the slash-command grammar used by the prompt editor / UserMessageCard
 * (word chars, colons, dots, hyphens — e.g. `/skill-creator:skill-creator`).
 */
export function parseLeadingSlashCommand(title: string): {
  command: string | null;
  rest: string;
} {
  const parsed = parseLeadingPromptCommand(title);
  if (parsed.kind !== 'slash') return { command: null, rest: title };
  return { command: parsed.command, rest: parsed.rest };
}

export type LeadingPromptCommandKind = 'slash' | 'shell' | null;

/**
 * Detect leading command-like prefixes in a thread title.
 *
 * `/name rest` is a slash/skill command. `! command` is a command-line prompt
 * and consumes the rest of the title as the shell command.
 */
export function parseLeadingPromptCommand(title: string): {
  kind: LeadingPromptCommandKind;
  command: string | null;
  rest: string;
} {
  const shellMatch = /^!\s*(\S.*)$/.exec(title);
  if (shellMatch) return { kind: 'shell', command: shellMatch[1].trim(), rest: '' };

  const slashMatch = /^\/([\w:.-]+)(?=\s|$)/.exec(title);
  if (!slashMatch) return { kind: null, command: null, rest: title };
  return {
    kind: 'slash',
    command: slashMatch[1],
    rest: title.slice(slashMatch[0].length).trimStart(),
  };
}
