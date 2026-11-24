import type { PRReactionContent, PRReactionSummary } from '@funny/shared';

import { timeAgo as relativeTimeAgo } from '@/components/pull-requests/time-ago';

/** Pure helpers of the pinned PR card: relative times and reaction counts. */

/** Relative age of a GitHub timestamp; empty when the timestamp is missing. */
export function timeAgo(dateStr: string, now = Date.now()): string {
  if (!dateStr) return '';
  return relativeTimeAgo(dateStr, now);
}

export const REACTION_EMOJI: Record<PRReactionContent, string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀',
};

export const REACTION_ORDER: PRReactionContent[] = [
  '+1',
  '-1',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
];

function reactionsTotal(r?: PRReactionSummary | null) {
  return r?.total ?? 0;
}

export function reactionCounts(r?: PRReactionSummary | null): Array<{
  key: PRReactionContent;
  count: number;
}> {
  if (!r) return [];
  const entries: Array<{ key: PRReactionContent; count: number }> = [
    { key: '+1', count: r.plus1 },
    { key: '-1', count: r.minus1 },
    { key: 'laugh', count: r.laugh },
    { key: 'hooray', count: r.hooray },
    { key: 'confused', count: r.confused },
    { key: 'heart', count: r.heart },
    { key: 'rocket', count: r.rocket },
    { key: 'eyes', count: r.eyes },
  ];
  return entries.filter((e) => e.count > 0);
}

/** Whether `author` is the signed-in GitHub user (case-insensitive). */
export function isOwnComment(author: string, currentUserLogin: string | undefined): boolean {
  return !!currentUserLogin && author.toLowerCase() === currentUserLogin.toLowerCase();
}

export function bumpReaction(r: PRReactionSummary, content: PRReactionContent): PRReactionSummary {
  const next = { ...r, total: reactionsTotal(r) + 1 };
  switch (content) {
    case '+1':
      next.plus1 += 1;
      break;
    case '-1':
      next.minus1 += 1;
      break;
    case 'laugh':
      next.laugh += 1;
      break;
    case 'hooray':
      next.hooray += 1;
      break;
    case 'confused':
      next.confused += 1;
      break;
    case 'heart':
      next.heart += 1;
      break;
    case 'rocket':
      next.rocket += 1;
      break;
    case 'eyes':
      next.eyes += 1;
      break;
  }
  return next;
}
