import { useEffect, useState } from 'react';

import type { GraphEntry } from '@/components/commit-graph/graph-entry';
import { authorAvatarUrl } from '@/lib/author-avatar';

// Process-lifetime cache of resolved email → avatar URL (GitHub .png / Gravatar),
// shared across remounts so we don't re-hash the same emails. Mirrors AuthorBadge.
const emailAvatarCache = new Map<string, string>();

/**
 * Resolve an avatar URL per author email (GitHub `.png` for `noreply` addresses,
 * else a Gravatar identicon). Works without a GitHub token and for local commits,
 * so every node can show a photo. Results are cached for the process lifetime.
 */
export function useEmailAvatars(entries: GraphEntry[]): Map<string, string> {
  const [avatarByEmail, setAvatarByEmail] = useState<Map<string, string>>(
    () => new Map(emailAvatarCache),
  );
  useEffect(() => {
    const emails = [
      ...new Set(
        entries
          .flatMap((e) => [e.authorEmail, e.committerEmail])
          .filter((email): email is string => !!email),
      ),
    ];
    const missing = emails.filter((e) => !avatarByEmail.has(e));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map(async (email) => [email, await authorAvatarUrl(email)] as const)).then(
      (pairs) => {
        if (cancelled) return;
        const resolved = pairs.filter((p): p is [string, string] => !!p[1]);
        if (resolved.length === 0) return;
        for (const [email, url] of resolved) {
          emailAvatarCache.set(email, url);
        }
        setAvatarByEmail((prev) => {
          const next = new Map(prev);
          for (const [email, url] of resolved) {
            next.set(email, url);
          }
          return next;
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entries, avatarByEmail]);
  return avatarByEmail;
}
