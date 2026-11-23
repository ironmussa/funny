/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * A run stacked on its blocker (openspec factory-integration D10): it builds
 * on the blocker's branch and its pull request targets it, so its review and
 * risk are about its own change. It waits for the blocker at the end of `ci`
 * (never inside `merge`: the merge group's slot is the blocker's way in), and
 * parks if the blocker ends without merging. Once the blocker landed, `merge`
 * retargets the pull request to the default branch and sends the run round
 * the loop to `integrate`, which brings the base in: so it is never batched
 * with its blocker, and what it merges was tested on the base.
 */

import { sleep as interruptibleSleep } from '@funny/shared/async';
import type { FactoryStackedOn } from '@funny/shared/contracts/factory';
import { okAsync, type Result } from 'neverthrow';

import type { UpdateRunInput } from './factory-runs.js';

/** Where a stacked run's blocker stands. */
export type BlockerState = 'in-flight' | 'merged' | 'gone';

export interface StackingDeps {
  stackedOn: FactoryStackedOn | null;
  defaultBranch?: () => PromiseLike<Result<string, { message: string }>>;
  blockerState?: () => Promise<BlockerState>;
  /** Point the run's pull request at `base` (the default branch, once the blocker landed). */
  retarget?: (base: string) => Promise<Result<void, string>>;
  record(input: UpdateRunInput): Promise<void>;
  signal: AbortSignal;
  pollMs?: number;
}

const POLL_MS = 30_000;

export function createStacking(deps: StackingDeps) {
  let stacked = deps.stackedOn;
  const onBlocker = (): boolean => !!stacked && !stacked.retargeted;

  return {
    onBlocker,

    /** The run's base: its blocker's branch until the blocker landed, then the default branch. */
    base(): PromiseLike<Result<string, { message: string }>> | undefined {
      if (stacked && onBlocker()) return okAsync(stacked.branch);
      return deps.defaultBranch?.();
    },

    /** The branch the review reads the change against while stacked; null otherwise. */
    diffBase: (): string | null => (stacked && onBlocker() ? stacked.branch : null),

    /**
     * Wait at the end of `ci` until the blocker merged. Null once it did (or
     * the run is not stacked); why it cannot go on otherwise.
     */
    async waitForBlocker(): Promise<string | null> {
      if (!stacked || !onBlocker() || !deps.blockerState) return null;
      while (!deps.signal.aborted) {
        const state = await deps.blockerState();
        if (state === 'merged') return null;
        if (state === 'gone') {
          return `The run this one is stacked on (#${stacked.issueNumber}) ended without merging: a person decides what to do with this pull request.`;
        }
        await interruptibleSleep(deps.pollMs ?? POLL_MS, deps.signal).catch(() => undefined);
      }
      return 'The run was stopped.';
    },

    /**
     * At `merge`: once the blocker landed, retarget the pull request to the
     * default branch (an API call, not GitHub's own retarget on branch
     * deletion). `retargeted`: the run must integrate the base before it merges.
     */
    async retargetIfLanded(): Promise<'retargeted' | 'not-stacked' | { error: string }> {
      if (!stacked || !onBlocker()) return 'not-stacked';
      const state = (await deps.blockerState?.()) ?? 'merged';
      if (state !== 'merged') {
        return {
          error: `Not merged: the run it is stacked on (#${stacked.issueNumber}) has not merged yet.`,
        };
      }
      const base = await deps.defaultBranch?.();
      if (!base || base.isErr() || !deps.retarget) {
        return {
          error: 'Not merged: the pull request could not be retargeted to the default branch.',
        };
      }
      const retargeted = await deps.retarget(base.value);
      if (retargeted.isErr())
        return { error: `Not merged: retargeting failed (${retargeted.error}).` };
      stacked = { ...stacked, retargeted: true };
      await deps.record({ stackedOn: stacked });
      return 'retargeted';
    },
  };
}

export type Stacking = ReturnType<typeof createStacking>;
