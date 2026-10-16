import type { IdleReapPolicy } from '@funny/core/agents';
import { describe, test, expect } from 'vitest';

import { IdleReaper, loadIdleReaperConfig } from '../../services/idle-reaper.js';

/**
 * Fake orchestrator surface. `getIdleCandidates` returns successive entries
 * from `sequences` (sticking on the last), so a test can model the candidate
 * set changing between the initial selection and the pre-kill re-check.
 */
function fakeOrch(sequences: string[][]) {
  let i = 0;
  return {
    reaped: [] as string[],
    getIdleCandidates(): string[] {
      const r = sequences[Math.min(i, sequences.length - 1)] ?? [];
      i++;
      return r;
    },
    async reapIdleAgent(threadId: string): Promise<void> {
      this.reaped.push(threadId);
    },
  };
}

const policy: IdleReapPolicy = { defaultIdleMs: 1, claudeIdleMs: 0 };
const cfg = (p: IdleReapPolicy = policy) => ({ policy: p, sweepMs: 1_000_000 });

describe('IdleReaper.sweep', () => {
  test('reaps every candidate the orchestrator reports', async () => {
    const orch = fakeOrch([['t1', 't2']]);
    await new IdleReaper(orch, cfg()).sweep();
    expect(orch.reaped).toEqual(['t1', 't2']);
  });

  test('re-checks before kill and skips a thread that became active', async () => {
    // Initial selection sees t1; the pre-kill re-check no longer does.
    const orch = fakeOrch([['t1'], []]);
    await new IdleReaper(orch, cfg()).sweep();
    expect(orch.reaped).toEqual([]);
  });

  test('does nothing when there are no candidates', async () => {
    const orch = fakeOrch([[]]);
    await new IdleReaper(orch, cfg()).sweep();
    expect(orch.reaped).toEqual([]);
  });
});

describe('loadIdleReaperConfig', () => {
  test('applies defaults when env is empty', () => {
    expect(loadIdleReaperConfig({})).toEqual({
      policy: { defaultIdleMs: 600_000, claudeIdleMs: 0 },
      sweepMs: 60_000,
    });
  });

  test('reads overrides from env', () => {
    expect(
      loadIdleReaperConfig({
        FUNNY_AGENT_IDLE_REAP_MS: '1000',
        FUNNY_AGENT_IDLE_REAP_MS_CLAUDE: '2000',
        FUNNY_AGENT_IDLE_SWEEP_MS: '500',
      }),
    ).toEqual({ policy: { defaultIdleMs: 1000, claudeIdleMs: 2000 }, sweepMs: 500 });
  });

  test('falls back to defaults on invalid values', () => {
    const c = loadIdleReaperConfig({
      FUNNY_AGENT_IDLE_REAP_MS: 'abc',
      FUNNY_AGENT_IDLE_SWEEP_MS: '-5',
    });
    expect(c.policy.defaultIdleMs).toBe(600_000);
    expect(c.sweepMs).toBe(60_000);
  });
});

describe('IdleReaper start/stop', () => {
  test('start is a no-op when both windows are disabled', () => {
    const orch = fakeOrch([[]]);
    const reaper = new IdleReaper(orch, {
      policy: { defaultIdleMs: 0, claudeIdleMs: 0 },
      sweepMs: 1000,
    });
    expect(() => {
      reaper.start();
      reaper.stop();
    }).not.toThrow();
  });

  test('start then stop tears down cleanly', () => {
    const orch = fakeOrch([[]]);
    const reaper = new IdleReaper(orch, cfg());
    reaper.start();
    expect(() => reaper.stop()).not.toThrow();
  });

  test('a slow reap never overlaps the next scheduled sweep', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let reaps = 0;
    const orch = {
      getIdleCandidates: () => ['t1'],
      async reapIdleAgent() {
        reaps++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight--;
      },
    };
    const reaper = new IdleReaper(orch, { policy, sweepMs: 5 });
    reaper.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    reaper.stop();
    expect(reaps).toBeGreaterThan(1);
    expect(maxInFlight).toBe(1);
  });

  test('a new instance stops the previous schedule (watch-mode reload)', async () => {
    const first = fakeOrch([['a']]);
    const second = fakeOrch([['b']]);
    new IdleReaper(first, { policy, sweepMs: 5 }).start();
    const current = new IdleReaper(second, { policy, sweepMs: 5 });
    current.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    current.stop();
    expect(first.reaped).toEqual([]);
    expect(second.reaped.length).toBeGreaterThan(0);
  });

  test('a sweep interval of 0 disables the reaper instead of spinning', async () => {
    const orch = fakeOrch([['t1']]);
    const reaper = new IdleReaper(orch, { policy, sweepMs: 0 });
    reaper.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    reaper.stop();
    expect(orch.reaped).toEqual([]);
  });
});
