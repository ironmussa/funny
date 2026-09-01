import { describe, expect, test } from 'vitest';

import { reduceQuestionTab } from '@/components/tool-cards/question-tab-state';

describe('reduceQuestionTab', () => {
  test('tracks forward and backward navigation without changing state for the active tab', () => {
    const initial = { activeTab: 1, slideDirection: 0 };

    expect(reduceQuestionTab(initial, 2)).toEqual({ activeTab: 2, slideDirection: 1 });
    expect(reduceQuestionTab(initial, 0)).toEqual({ activeTab: 0, slideDirection: -1 });
    expect(reduceQuestionTab(initial, 1)).toBe(initial);
  });
});
