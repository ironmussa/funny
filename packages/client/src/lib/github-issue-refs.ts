/**
 * Turns GitHub's short references (`#555`) in a markdown body into links to
 * the repository's issue, as GitHub does on its own pages (`/issues/N`
 * redirects to `/pull/N` for a pull request).
 *
 * Code is left alone: fenced blocks, inline code spans, existing links and
 * bare URLs keep their text.
 */

/** `https://github.com/owner/repo` of an issue or PR URL; `null` for anything else. */
export function githubRepoBaseUrl(itemUrl: string | undefined): string | null {
  const match = itemUrl?.match(/^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/#?]+)/i);
  return match ? match[1] : null;
}

/** Spans of a line that must not change: inline code, markdown links, autolinks, URLs. */
const PROTECTED = /(`+[^`]*`+|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|https?:\/\/\S+)/;

/** `#N` after the start, whitespace or opening punctuation, not followed by a word character. */
const REFERENCE = /(^|[\s([{,;:])#(\d+)(?![\w-])/g;

function linkLine(line: string, repoUrl: string): string {
  return line
    .split(PROTECTED)
    .map((part, index) =>
      // `split` with a capturing group puts the protected spans at odd indexes.
      index % 2 === 1
        ? part
        : part.replace(
            REFERENCE,
            (_, lead: string, n: string) => `${lead}[#${n}](${repoUrl}/issues/${n})`,
          ),
    )
    .join('');
}

export function linkIssueReferences(body: string, repoUrl: string | null): string {
  if (!repoUrl || !body.includes('#')) return body;
  let fence: string | null = null;
  return body
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (marker) {
        if (!fence) fence = marker[0];
        else if (marker[0] === fence) fence = null;
        return line;
      }
      return fence ? line : linkLine(line, repoUrl);
    })
    .join('\n');
}
