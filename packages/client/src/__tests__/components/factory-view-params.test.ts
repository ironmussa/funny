import { describe, expect, test } from 'bun:test';

import {
  applyFactoryViewPatch,
  parseFactoryViewParams,
} from '@/components/factory-board/factory-view-params';

describe('factory view search parameters', () => {
  test('reads the filters and ignores an unknown layout', () => {
    const filters = parseFactoryViewParams(
      new URLSearchParams('project=p1,p2&status=failed&search=Slug&cs=1&active=1&view=grid'),
    );
    expect([...filters.projectIds]).toEqual(['p1', 'p2']);
    expect([...filters.states]).toEqual(['failed']);
    expect(filters.search).toBe('Slug');
    expect(filters.caseSensitive).toBe(true);
    expect(filters.activeOnly).toBe(true);
    expect(filters.layout).toBeNull();
  });

  test('writes a patch, drops empty filters and keeps other parameters', () => {
    const next = applyFactoryViewPatch(new URLSearchParams('run=r1&status=failed&active=1'), {
      states: new Set(),
      activeOnly: false,
      projectIds: new Set(['p1', 'p2']),
      layout: 'board',
    });
    expect(next.toString()).toBe('run=r1&project=p1%2Cp2&view=board');
  });

  // openspec factory-lanes: the lane filter travels in the link like the others.
  test('reads and writes the lane filter, the no-lane value included', () => {
    const filters = parseFactoryViewParams(new URLSearchParams('lane=payments,~none'));
    expect([...filters.lanes]).toEqual(['payments', '~none']);
    const next = applyFactoryViewPatch(new URLSearchParams('lane=payments'), {
      lanes: new Set(['auth']),
    });
    expect(next.get('lane')).toBe('auth');
    expect(applyFactoryViewPatch(next, { lanes: new Set() }).has('lane')).toBe(false);
  });
});
