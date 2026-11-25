import { describe, expect, test } from 'bun:test';

import type { FactoryRun } from '@funny/shared/contracts/factory';

import {
  approvalRequestCards,
  factoryCardKey,
  factoryTimelineCards,
  isTrailingFactoryCard,
} from '@/lib/factory-timeline';

type CardRun = Parameters<typeof factoryTimelineCards>[0];

const ids = { projectId: 'p1', threadId: 't1' };
const run = (over: Partial<NonNullable<CardRun>> = {}): NonNullable<CardRun> => ({
  state: 'waiting_ci',
  failureReason: null,
  completedAt: null,
  regressionProof: null,
  stepTimings: [],
  ...over,
});
const proof = (ranAt: string): FactoryRun['regressionProof'] => ({
  headSha: 'abc',
  verdict: 'fail',
  ranAt,
});

describe('factoryTimelineCards', () => {
  test('no run, no cards; a proof is placed when it ran', () => {
    expect(factoryTimelineCards(null, ids, false)).toEqual([]);
    expect(
      factoryTimelineCards(run({ regressionProof: proof('2026-11-23T22:26:13Z') }), ids, false),
    ).toEqual([{ kind: 'proof', at: '2026-11-23T22:26:13Z', ...ids }]);
  });

  test('a failed run is placed when it ended', () => {
    const cards = factoryTimelineCards(
      run({ state: 'failed', failureReason: 'x', completedAt: '2026-11-23T22:39:00Z' }),
      ids,
      false,
    );
    expect(cards).toEqual([{ kind: 'failure', at: '2026-11-23T22:39:00Z', ...ids }]);
  });

  test('a run parked after a failure is placed when its failed step finished', () => {
    const cards = factoryTimelineCards(
      run({
        state: 'waiting_human',
        failureReason: 'merge failed',
        stepTimings: [
          {
            step: 'ci',
            visit: '1',
            attempt: 1,
            status: 'succeeded',
            startedAt: '2026-11-23T23:06:00Z',
            finishedAt: '2026-11-23T23:10:00Z',
          },
          {
            step: 'merge',
            visit: '1',
            attempt: 1,
            status: 'failed',
            startedAt: '2026-11-23T23:13:00Z',
            finishedAt: '2026-11-23T23:13:27Z',
          },
        ],
      }),
      ids,
      false,
    );
    expect(cards.map((c) => c.at)).toEqual(['2026-11-23T23:13:27Z']);
  });

  test('no failure card while the agent works on the thread again', () => {
    expect(factoryTimelineCards(run({ state: 'failed', failureReason: 'x' }), ids, true)).toEqual(
      [],
    );
  });
});

describe('isTrailingFactoryCard', () => {
  const messages = [
    { timestamp: '2026-11-23T22:00:00Z', toolCalls: [{ timestamp: '2026-11-23T22:05:00Z' }] },
  ];

  test('newer than every message or tool call, or of unknown time: trailing', () => {
    expect(isTrailingFactoryCard({ at: '2026-11-23T22:06:00Z' }, messages)).toBe(true);
    expect(isTrailingFactoryCard({ at: null }, messages)).toBe(true);
  });

  test('a tool call after it: in the list', () => {
    expect(isTrailingFactoryCard({ at: '2026-11-23T22:03:00Z' }, messages)).toBe(false);
  });
});

describe('approvalRequestCards', () => {
  const request = (id: string, createdAt: string, threadId = 't1') => ({ id, createdAt, threadId });

  test('one card per request of the thread, at the time the agent asked, oldest first', () => {
    const cards = approvalRequestCards(
      [
        request('q2', '2026-11-25T00:44:00.000Z'),
        request('q1', '2026-11-24T23:00:00.000Z'),
        request('q9', '2026-11-25T00:00:00.000Z', 't-other'),
      ],
      ids,
    );
    expect(cards).toEqual([
      { kind: 'approval-request', at: '2026-11-24T23:00:00.000Z', requestId: 'q1', ...ids },
      { kind: 'approval-request', at: '2026-11-25T00:44:00.000Z', requestId: 'q2', ...ids },
    ]);
    // Two requests in one thread are two list items.
    expect(cards.map(factoryCardKey)).toEqual(['approval-request-q1', 'approval-request-q2']);
    expect(factoryCardKey({ kind: 'proof' })).toBe('proof');
  });

  test('a request sits among the messages once the thread goes on, and trails until then', () => {
    const [card] = approvalRequestCards([request('q1', '2026-11-25T00:44:00.000Z')], ids);
    expect(isTrailingFactoryCard(card, [{ timestamp: '2026-11-25T00:40:00.000Z' }])).toBe(true);
    expect(isTrailingFactoryCard(card, [{ timestamp: '2026-11-25T00:50:00.000Z' }])).toBe(false);
  });
});
