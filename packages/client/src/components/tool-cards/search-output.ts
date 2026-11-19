/**
 * Reads the output of a text search (`rg`, `grep`, `git grep`) as results
 * grouped by file, so the command card can show it like a search panel instead
 * of a wall of `path:line:text` lines.
 */

export interface SearchMatch {
  line: number;
  text: string;
}

export type SearchOutputBlock =
  | { kind: 'file'; path: string; matches: SearchMatch[] }
  | { kind: 'matches'; matches: SearchMatch[] }
  | { kind: 'note'; text: string };

const SEARCH_COMMAND = /(^|[\s;&|(])(rg|grep|egrep|fgrep|git\s+grep)(\s|$)/;
/** `path:12:text` — the path has no colon and does not start with a space. */
const PATH_MATCH = /^([^\s:][^:]*?):(\d+):(.*)$/;
/** `12:text` — a search in one file prints no path. */
const BARE_MATCH = /^(\d+):(.*)$/;
/** A path alone (`rg -l`): has a slash or an extension, no spaces. */
const PATH_ONLY = /^(?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*$/;

function looksLikePath(line: string): boolean {
  return PATH_ONLY.test(line) && (line.includes('/') || /\.\w+$/.test(line));
}

export function isSearchCommand(command: string): boolean {
  return SEARCH_COMMAND.test(command);
}

/** What one output line is: a match (with or without its path), a path alone, or a note. */
type SearchLine =
  | { kind: 'match'; path: string | null; match: SearchMatch }
  | { kind: 'path'; path: string }
  | { kind: 'note'; text: string };

function classifyLine(line: string): SearchLine {
  const pathMatch = PATH_MATCH.exec(line);
  if (pathMatch && looksLikePath(pathMatch[1])) {
    return {
      kind: 'match',
      path: pathMatch[1],
      match: { line: Number(pathMatch[2]), text: pathMatch[3].trim() },
    };
  }
  const bareMatch = BARE_MATCH.exec(line);
  if (bareMatch) {
    return {
      kind: 'match',
      path: null,
      match: { line: Number(bareMatch[1]), text: bareMatch[2].trim() },
    };
  }
  if (looksLikePath(line)) return { kind: 'path', path: line };
  return { kind: 'note', text: line };
}

/** Append a match to the block it belongs to, or start one. */
function addMatch(blocks: SearchOutputBlock[], path: string | null, match: SearchMatch): void {
  const prev = blocks[blocks.length - 1];
  if (path === null) {
    if (prev && prev.kind !== 'note') prev.matches.push(match);
    else blocks.push({ kind: 'matches', matches: [match] });
    return;
  }
  if (prev?.kind === 'file' && prev.path === path) prev.matches.push(match);
  else blocks.push({ kind: 'file', path, matches: [match] });
}

/** Start a file block for a path alone, unless the previous block is that file. */
function addPath(blocks: SearchOutputBlock[], path: string): void {
  const prev = blocks[blocks.length - 1];
  if (!(prev?.kind === 'file' && prev.path === path)) {
    blocks.push({ kind: 'file', path, matches: [] });
  }
}

/**
 * The blocks of a search output, or null when it does not read as one (no
 * line is a match or a file path). Lines that are neither, such as the shell's
 * `Shell cwd was reset to …` note, become `note` blocks.
 */
export function parseSearchOutput(output: string): SearchOutputBlock[] | null {
  const blocks: SearchOutputBlock[] = [];
  let results = 0;
  for (const raw of output.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line || line === '--') continue;
    const read = classifyLine(line);
    if (read.kind === 'note') {
      blocks.push(read);
      continue;
    }
    results++;
    if (read.kind === 'match') addMatch(blocks, read.path, read.match);
    else addPath(blocks, read.path);
  }
  return results > 0 ? blocks : null;
}
