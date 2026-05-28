import { describe, expect, test } from 'vitest';

import { getActiveWS } from '@/hooks/use-ws';

describe('use-ws helpers', () => {
  test('getActiveWS returns null before any connection is established', () => {
    expect(getActiveWS()).toBeNull();
  });
});
