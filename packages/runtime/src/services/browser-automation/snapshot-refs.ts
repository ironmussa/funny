/**
 * Element-reference expiry for agent snapshots.
 *
 * Playwright's AI snapshot tags elements with `[ref=eN]` and resolves them with
 * the `aria-ref=eN` selector, but it keeps old refs resolvable across
 * snapshots and navigations — and ref numbers get reused, so a stale `e5` can
 * silently hit a different element. We therefore scope refs to a snapshot
 * *generation*: a ref is only usable if it appeared in the latest snapshot and
 * nothing has invalidated that snapshot since (navigation, a newer snapshot,
 * or a change of control between user and agent).
 */

export type RefInvalidationReason = 'navigation' | 'snapshot' | 'control';

export type RefCheck =
  | { ok: true }
  | { ok: false; reason: 'no-snapshot' | 'unknown-ref' | RefInvalidationReason };

const REF_PATTERN = /\[ref=(e\d+)\]/g;

/** Extract every `[ref=eN]` id from an AI snapshot. */
export function extractRefs(snapshot: string): Set<string> {
  const refs = new Set<string>();
  for (const match of snapshot.matchAll(REF_PATTERN)) refs.add(match[1]);
  return refs;
}

export class RefGenerations {
  private generation = 0;
  private refs: Set<string> | null = null;
  private invalidatedBy: RefInvalidationReason | null = null;

  /** Record a new snapshot; refs from earlier snapshots stop being valid. */
  recordSnapshot(snapshot: string): number {
    this.generation += 1;
    this.refs = extractRefs(snapshot);
    this.invalidatedBy = null;
    return this.generation;
  }

  /** Drop the current snapshot's refs (navigation or control change). */
  invalidate(reason: Exclude<RefInvalidationReason, 'snapshot'>): void {
    if (!this.refs) return;
    this.refs = null;
    this.invalidatedBy = reason;
  }

  check(ref: string): RefCheck {
    if (!this.refs) {
      return { ok: false, reason: this.invalidatedBy ?? 'no-snapshot' };
    }
    if (this.refs.has(ref)) return { ok: true };
    return { ok: false, reason: this.generation > 1 ? 'snapshot' : 'unknown-ref' };
  }
}
