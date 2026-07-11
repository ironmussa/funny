import { parseReferencedFiles, type ReferencedItem } from './parse-referenced-files';

const LINEAR_ISSUE_URL_RE =
  /https?:\/\/linear\.app\/[^\s)]+\/issue\/([a-z][a-z0-9]+-\d+)(?:\/[^\s)]*)?/i;
const GITHUB_PULL_REQUEST_URL_RE =
  /https?:\/\/github\.com\/([^/\s)]+)\/([^/\s)]+)\/pull\/(\d+)(?:\/[^\s)]*)?/i;
const TRAILING_URL_PUNCTUATION_RE = /[.,;:!?)\]]+$/;

export interface LinearIssueReference {
  issueKey: string;
  url: string;
  displayTitle: string;
}

export interface GitHubPullRequestReference {
  owner: string;
  repo: string;
  prNumber: number;
  url: string;
  displayTitle: string;
}

export type ThreadTitlePart =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'linearIssue'; reference: LinearIssueReference }
  | { id: string; kind: 'githubPullRequest'; reference: GitHubPullRequestReference };

type TitleReferenceMatch =
  | {
      kind: 'linearIssue';
      index: number;
      matchedUrl: string;
      reference: LinearIssueReference;
    }
  | {
      kind: 'githubPullRequest';
      index: number;
      matchedUrl: string;
      reference: GitHubPullRequestReference;
    };

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

export function parseLinearIssueReference(title: string): LinearIssueReference | null {
  const match = LINEAR_ISSUE_URL_RE.exec(title);
  if (!match) return null;

  const matchedUrl = match[0];
  const url = matchedUrl.replace(TRAILING_URL_PUNCTUATION_RE, '');
  const displayTitle =
    `${title.slice(0, match.index)} ${title.slice(match.index + matchedUrl.length)}`
      .replace(/\s+/g, ' ')
      .trim();

  return {
    issueKey: match[1].toUpperCase(),
    url,
    displayTitle,
  };
}

export function parseGitHubPullRequestReference(title: string): GitHubPullRequestReference | null {
  const match = GITHUB_PULL_REQUEST_URL_RE.exec(title);
  if (!match) return null;

  const matchedUrl = match[0];
  const url = matchedUrl.replace(TRAILING_URL_PUNCTUATION_RE, '');
  const displayTitle =
    `${title.slice(0, match.index)} ${title.slice(match.index + matchedUrl.length)}`
      .replace(/\s+/g, ' ')
      .trim();

  return {
    owner: match[1],
    repo: match[2],
    prNumber: Number(match[3]),
    url,
    displayTitle,
  };
}

function normalizeTextPart(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function findNextTitleReference(title: string): TitleReferenceMatch | null {
  const linearMatch = LINEAR_ISSUE_URL_RE.exec(title);
  const githubPrMatch = GITHUB_PULL_REQUEST_URL_RE.exec(title);
  const matches: TitleReferenceMatch[] = [];

  if (linearMatch) {
    const matchedUrl = linearMatch[0];
    matches.push({
      kind: 'linearIssue',
      index: linearMatch.index,
      matchedUrl,
      reference: {
        issueKey: linearMatch[1].toUpperCase(),
        url: matchedUrl.replace(TRAILING_URL_PUNCTUATION_RE, ''),
        displayTitle: `${title.slice(0, linearMatch.index)} ${title.slice(
          linearMatch.index + matchedUrl.length,
        )}`
          .replace(/\s+/g, ' ')
          .trim(),
      },
    });
  }

  if (githubPrMatch) {
    const matchedUrl = githubPrMatch[0];
    matches.push({
      kind: 'githubPullRequest',
      index: githubPrMatch.index,
      matchedUrl,
      reference: {
        owner: githubPrMatch[1],
        repo: githubPrMatch[2],
        prNumber: Number(githubPrMatch[3]),
        url: matchedUrl.replace(TRAILING_URL_PUNCTUATION_RE, ''),
        displayTitle: `${title.slice(0, githubPrMatch.index)} ${title.slice(
          githubPrMatch.index + matchedUrl.length,
        )}`
          .replace(/\s+/g, ' ')
          .trim(),
      },
    });
  }

  if (matches.length === 0) return null;
  return matches.sort((a, b) => a.index - b.index)[0];
}

export function parseThreadTitleParts(title: string): ThreadTitlePart[] {
  const parts: ThreadTitlePart[] = [];
  let remaining = title;
  let consumed = 0;

  while (remaining) {
    const match = findNextTitleReference(remaining);
    if (!match) break;

    const referenceOffset = consumed + match.index;
    const before = normalizeTextPart(remaining.slice(0, match.index));
    if (before) parts.push({ id: `text:${consumed}:${before}`, kind: 'text', text: before });

    parts.push(
      match.kind === 'linearIssue'
        ? {
            id: `linearIssue:${referenceOffset}:${match.reference.url}`,
            kind: 'linearIssue',
            reference: match.reference,
          }
        : {
            id: `githubPullRequest:${referenceOffset}:${match.reference.url}`,
            kind: 'githubPullRequest',
            reference: match.reference,
          },
    );

    consumed = referenceOffset + match.matchedUrl.length;
    remaining = remaining.slice(match.index + match.matchedUrl.length);
  }

  const trailing = parts.length > 0 ? normalizeTextPart(remaining) : remaining;
  if (trailing) parts.push({ id: `text:${consumed}:${trailing}`, kind: 'text', text: trailing });

  return parts;
}

export interface ParsedThreadTitle {
  displayTitle: string;
  attachedFiles: ReferencedItem[];
  leadingCommand: {
    kind: LeadingPromptCommandKind;
    command: string | null;
    rest: string;
  };
  linearIssue: LinearIssueReference | null;
  githubPullRequest: GitHubPullRequestReference | null;
  titleParts: ThreadTitlePart[];
  visibleText: string;
}

export function parseThreadTitleForDisplay(title: string): ParsedThreadTitle {
  const { displayTitle, attachedFiles } = cleanThreadTitle(title);
  const leadingCommand = parseLeadingPromptCommand(displayTitle);
  const commandRest = leadingCommand.kind === 'slash' ? leadingCommand.rest : displayTitle;
  const titleParts = parseThreadTitleParts(commandRest);
  const linearIssue = titleParts.find((part) => part.kind === 'linearIssue')?.reference ?? null;
  const githubPullRequest =
    titleParts.find((part) => part.kind === 'githubPullRequest')?.reference ?? null;
  const visibleText = titleParts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim();

  return {
    displayTitle,
    attachedFiles,
    leadingCommand,
    linearIssue,
    githubPullRequest,
    titleParts,
    visibleText,
  };
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
