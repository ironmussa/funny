import { describe, expect, test } from 'bun:test';

import { factoryRunIssueUrl } from '@/components/factory-board/FactoryRunCard';

describe('factoryRunIssueUrl', () => {
  test('beside the pull request when the run has one', () => {
    expect(factoryRunIssueUrl('https://github.com/o/r/pull/12', undefined, 7)).toBe(
      'https://github.com/o/r/issues/7',
    );
  });

  test('in the project repository when the run has no pull request yet', () => {
    expect(factoryRunIssueUrl(null, 'https://github.com/o/r', 7)).toBe(
      'https://github.com/o/r/issues/7',
    );
  });

  test('nothing when neither the pull request nor the repository is known', () => {
    expect(factoryRunIssueUrl(null, undefined, 7)).toBeUndefined();
  });
});
