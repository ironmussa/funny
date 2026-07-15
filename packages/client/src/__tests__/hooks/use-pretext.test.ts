import { describe, expect, test } from 'vitest';

import { isPretextReady, preloadPretext } from '@/hooks/use-pretext';

describe('preloadPretext', () => {
  test('loads the layout engine before any message is measured', async () => {
    await preloadPretext();

    expect(isPretextReady()).toBe(true);
  });
});
