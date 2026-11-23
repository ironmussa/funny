import { describe, expect, test } from 'bun:test';

import type { FactoryStepTiming } from '@funny/shared/contracts/factory';

import { stageOfStep } from '@/components/factory-board/step-stage';
import {
  formatStepDuration,
  stageMedians,
  stepTimeline,
  timeInCurrentStep,
} from '@/components/factory-board/step-timings';
import { buildFactoryRun } from '@/data/factory/testing';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const minAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

const timing = (
  step: string,
  startedMinAgo: number,
  endedMinAgo: number | null,
  over: Partial<FactoryStepTiming> = {},
): FactoryStepTiming => ({
  step,
  visit: '1',
  attempt: 1,
  status: endedMinAgo === null ? 'running' : 'succeeded',
  startedAt: minAgo(startedMinAgo),
  finishedAt: endedMinAgo === null ? null : minAgo(endedMinAgo),
  ...over,
});

describe('stageOfStep', () => {
  test("the built-in flows' steps, a retry's fix step, and others nowhere", () => {
    expect(stageOfStep('address')).toBe('implementing');
    expect(stageOfStep('ci')).toBe('pr');
    expect(stageOfStep('implement.before_retry')).toBe('implementing');
    expect(stageOfStep('my-custom-step')).toBeNull();
  });
});

describe('timeInCurrentStep', () => {
  test('a long review: since its latest execution started', () => {
    const run = buildFactoryRun({
      state: 'reviewing',
      currentStep: 'review',
      stepTimings: [
        timing('review', 300, 280),
        timing('address', 270, 130),
        timing('review', 120, null),
      ],
    });
    expect(timeInCurrentStep(run)).toEqual({ kind: 'in-step', since: NOW - 120 * 60_000 });
  });

  test('waiting for the merge slot: since the last execution ended', () => {
    const run = buildFactoryRun({
      state: 'merging',
      currentStep: 'merge',
      stepTimings: [timing('ci', 60, 40), timing('review', 39, 20)],
    });
    expect(timeInCurrentStep(run)).toEqual({ kind: 'waiting', since: NOW - 20 * 60_000 });
  });

  test('back in merge after merge sent it back: waiting again, not since the old merge', () => {
    const run = buildFactoryRun({
      state: 'merging',
      currentStep: 'merge',
      stepTimings: [
        timing('merge', 200, 190),
        timing('address', 189, 150),
        timing('review', 149, 30),
      ],
    });
    expect(timeInCurrentStep(run)).toEqual({ kind: 'waiting', since: NOW - 30 * 60_000 });
  });

  test('nothing without timings, or outside the timed columns', () => {
    expect(
      timeInCurrentStep(buildFactoryRun({ state: 'reviewing', currentStep: 'review' })),
    ).toBeNull();
    expect(
      timeInCurrentStep(
        buildFactoryRun({ state: 'failed', currentStep: 'ci', stepTimings: [timing('ci', 9, 5)] }),
      ),
    ).toBeNull();
  });
});

describe('stepTimeline', () => {
  test('a retried step and a 15 min wait; a wait under a minute is not shown', () => {
    const entries = stepTimeline(
      {
        stepTimings: [
          timing('ci', 100, 90, { status: 'failed' }),
          timing('ci', 89.5, 80, { attempt: 2 }),
          timing('review', 79, 60),
          timing('merge', 45, null),
        ],
      },
      NOW,
    );
    expect(
      entries.map((entry) => [entry.timing.step, entry.timing.attempt, entry.durationMs]),
    ).toEqual([
      ['ci', 1, 10 * 60_000],
      ['ci', 2, 9.5 * 60_000],
      ['review', 1, 19 * 60_000],
      ['merge', 1, 45 * 60_000],
    ]);
    expect(entries[1]?.waitBeforeMs).toBeUndefined();
    expect(entries[2]?.waitBeforeMs).toBe(60_000);
    expect(entries[3]?.waitBeforeMs).toBe(15 * 60_000);
  });

  test('no timeline without timings', () => {
    expect(stepTimeline({}, NOW)).toEqual([]);
  });
});

describe('stageMedians', () => {
  test('the median review time over the last week, older and unknown steps ignored', () => {
    const medians = stageMedians(
      [
        { stepTimings: [timing('review', 20, 10)] },
        { stepTimings: [timing('review', 100, 80), timing('review', 70, 50)] },
        { stepTimings: [timing('review', 200, 80)] },
        { stepTimings: [timing('review', 60 * 24 * 9, 60 * 24 * 8)] },
        { stepTimings: [timing('my-custom-step', 30, 0)] },
      ],
      NOW,
    );
    expect(medians.review).toBe(40 * 60_000);
    expect(medians.merge).toBeUndefined();
    expect(Object.keys(medians)).toEqual(['review']);
  });
});

describe('formatStepDuration', () => {
  test('under a minute, minutes, hours and minutes', () => {
    expect(formatStepDuration(30_000)).toBe('<1m');
    expect(formatStepDuration(20 * 60_000 + 59_000)).toBe('20m');
    expect(formatStepDuration(120 * 60_000)).toBe('2h');
    expect(formatStepDuration(135 * 60_000)).toBe('2h 15m');
  });
});
