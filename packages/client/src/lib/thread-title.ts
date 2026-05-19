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
