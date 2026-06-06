async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const NOREPLY_RE = /^(?:(\d+)\+)?([^@\s]+)@users\.noreply\.github\.com$/i;

export async function authorAvatarUrl(email: string | undefined | null): Promise<string | null> {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const match = normalized.match(NOREPLY_RE);
  if (match) {
    const id = match[1];
    const username = match[2];
    // Bot accounts (e.g. "dependabot[bot]") contain brackets that break the
    // username-based avatar URL. The noreply email prefixes the numeric user id
    // (e.g. "49699333+dependabot[bot]@…"), so prefer the id-based avatar
    // endpoint when present — it resolves for both users and bots. Fall back to
    // the (url-encoded) username only when no id is available.
    if (id) return `https://avatars.githubusercontent.com/u/${id}?size=64`;
    return `https://github.com/${encodeURIComponent(username)}.png?size=64`;
  }

  const hash = await sha256Hex(normalized);
  return `https://gravatar.com/avatar/${hash}?s=64&d=identicon`;
}
