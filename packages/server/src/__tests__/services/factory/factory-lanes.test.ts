/**
 * Which lane an issue's labels name (openspec factory-lanes, D1): the pure
 * rule, apart from the admission that acts on it.
 */
import { describe, expect, test } from 'bun:test';

import { resolveLane } from '../../../services/factory/factory-lanes.js';

const prefixes = { laneLabelPrefix: 'feature:', laneBranchPrefix: 'feature/' };

describe('resolveLane', () => {
  test('no lane label: no lane', () => {
    expect(resolveLane(['bug', 'ready-for-agent'], prefixes)).toEqual({ kind: 'none' });
    expect(resolveLane([], prefixes)).toEqual({ kind: 'none' });
  });

  test("a lane label names the lane and its branch, whatever the label's case", () => {
    expect(resolveLane(['ready-for-agent', 'feature:payments'], prefixes)).toEqual({
      kind: 'lane',
      name: 'payments',
      branch: 'feature/payments',
    });
    expect(resolveLane(['Feature:Payments'], prefixes)).toEqual({
      kind: 'lane',
      name: 'payments',
      branch: 'feature/payments',
    });
  });

  test('the same lane named twice is one lane', () => {
    expect(resolveLane(['feature:a', 'Feature:A'], prefixes)).toMatchObject({
      kind: 'lane',
      name: 'a',
    });
  });

  test('two lanes at once: the factory does not pick one', () => {
    expect(resolveLane(['feature:b', 'feature:a'], prefixes)).toEqual({
      kind: 'ambiguous',
      names: ['a', 'b'],
    });
  });

  test('a name that is not a branch is refused', () => {
    expect(resolveLane(['feature:a..b'], prefixes).kind).toBe('invalid');
    expect(resolveLane(['feature:'], prefixes).kind).toBe('invalid');
    expect(resolveLane(['feature:has space'], prefixes).kind).toBe('invalid');
  });

  test('a lane may not be the branch the factory merges into, nor the default branch', () => {
    const lane = { laneLabelPrefix: 'to:', laneBranchPrefix: '' };
    expect(resolveLane(['to:dev'], { ...lane, laneBranchPrefix: 'x' }, ['xdev']).kind).toBe(
      'invalid',
    );
    expect(resolveLane(['feature:a'], prefixes, ['dev', 'main'])).toMatchObject({ kind: 'lane' });
  });

  test("the factory's own prefixes are the ones that count", () => {
    const custom = { laneLabelPrefix: 'epic/', laneBranchPrefix: 'epics/' };
    expect(resolveLane(['feature:a'], custom)).toEqual({ kind: 'none' });
    expect(resolveLane(['epic/billing'], custom)).toEqual({
      kind: 'lane',
      name: 'billing',
      branch: 'epics/billing',
    });
  });
});
