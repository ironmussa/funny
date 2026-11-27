import { describe, expect, test } from 'bun:test';

import type { FactoryLane } from '@funny/shared/contracts/factory';

import {
  KEEP_LANE,
  NEW_LANE,
  activeLanesOf,
  blockersOutside,
  sendBranchesOf,
  sendLaneChoice,
  summaryLaneOf,
} from '@/components/issues/issue-factory-send';

function lane(overrides: Partial<FactoryLane>): FactoryLane {
  // SAFETY: the functions under test read only the fields set here.
  return {
    id: 'lane-1',
    name: 'payments',
    label: 'lane:payments',
    branch: 'lane/payments',
    baseBranch: null,
    finishBranch: null,
    state: 'active',
    ...overrides,
  } as FactoryLane;
}

const settings = { baseBranch: 'develop', laneFinishBranch: 'release' };

describe('issue factory send decisions', () => {
  test('activeLanesOf keeps the active lanes and takes a list still loading as empty', () => {
    const active = lane({});
    const other = lane({ id: 'lane-2', state: 'finished' as FactoryLane['state'] });
    expect(activeLanesOf([active, other])).toEqual([active]);
    expect(activeLanesOf(undefined)).toEqual([]);
  });

  test('sendLaneChoice: no lane keeps the labels', () => {
    expect(sendLaneChoice([lane({})], KEEP_LANE, 'ignored', 'lane:')).toEqual({
      name: null,
      label: null,
      invalid: false,
      existing: null,
    });
  });

  test('sendLaneChoice: an existing lane is found by its name', () => {
    const existing = lane({});
    expect(sendLaneChoice([existing], 'payments', '', 'lane:')).toEqual({
      name: 'payments',
      label: 'lane:payments',
      invalid: false,
      existing,
    });
  });

  test('sendLaneChoice: a new lane takes the typed name, or is invalid', () => {
    expect(sendLaneChoice([], NEW_LANE, ' Billing ', 'lane:')).toEqual({
      name: 'billing',
      label: 'lane:billing',
      invalid: false,
      existing: null,
    });
    expect(sendLaneChoice([], NEW_LANE, 'two words', 'lane:')).toEqual({
      name: null,
      label: null,
      invalid: true,
      existing: null,
    });
  });

  test('summaryLaneOf: a new lane gets the prefixed branch, an existing one its own', () => {
    expect(summaryLaneOf(sendLaneChoice([], KEEP_LANE, '', 'lane:'), 'lane/')).toBeNull();
    expect(summaryLaneOf(sendLaneChoice([], NEW_LANE, 'billing', 'lane:'), 'lane/')).toEqual({
      label: 'lane:billing',
      branch: 'lane/billing',
      isNew: true,
    });
    const existing = lane({ branch: 'feature/pay' });
    expect(summaryLaneOf(sendLaneChoice([existing], 'payments', '', 'lane:'), 'lane/')).toEqual({
      label: 'lane:payments',
      branch: 'feature/pay',
      isNew: false,
    });
  });

  test('sendBranchesOf: the dialog choice without an existing lane', () => {
    expect(sendBranchesOf(null, settings, { base: 'main', finish: '' }, undefined)).toEqual({
      base: 'main',
      finish: '',
      baseIsBranch: true,
      finishIsBranch: true,
    });
    expect(sendBranchesOf(null, settings, { base: '', finish: '' }, undefined)).toEqual({
      base: '',
      finish: '',
      baseIsBranch: false,
      finishIsBranch: false,
    });
    expect(sendBranchesOf(null, settings, { base: '', finish: '' }, 'master').baseIsBranch).toBe(
      true,
    );
  });

  test('sendBranchesOf: an existing lane keeps its branches, else the settings', () => {
    const route = { base: 'ignored', finish: 'ignored' };
    expect(sendBranchesOf(lane({}), settings, route, undefined)).toMatchObject({
      base: 'develop',
      finish: 'release',
    });
    expect(
      sendBranchesOf(lane({ baseBranch: 'main', finishBranch: 'prod' }), settings, route, 'x'),
    ).toMatchObject({ base: 'main', finish: 'prod' });
  });

  test('blockersOutside lists once the blockers neither in the factory nor selected', () => {
    const blockers = [
      {
        blockers: [
          { issue: 7, inFactory: false },
          { issue: 8, inFactory: true },
          { issue: 2, inFactory: false },
        ],
      },
      { blockers: [{ issue: 7, inFactory: false }] },
    ];
    expect(blockersOutside(blockers, [1, 2])).toEqual([7]);
    expect(blockersOutside(undefined, [1])).toEqual([]);
  });
});
