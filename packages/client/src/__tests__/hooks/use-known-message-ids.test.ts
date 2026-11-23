import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';

import { useKnownMessageIds } from '@/hooks/use-known-message-ids';

const first: Array<{ id: string; toolCalls?: Array<{ id: string }> }> = [
  { id: 'm1', toolCalls: [{ id: 't1' }] },
];
const grown = [...first, { id: 'm2' }];

test('keeps the snapshot while the thread stays the same', () => {
  const { result, rerender } = renderHook(
    ({ threadId, messages }) => useKnownMessageIds(threadId, messages),
    { initialProps: { threadId: 'a', messages: first } },
  );
  expect([...result.current]).toEqual(['m1', 't1']);
  const before = result.current;

  rerender({ threadId: 'a', messages: grown });

  expect(result.current).toBe(before);
  expect(result.current.has('m2')).toBe(false);
});

test('retakes the snapshot when the thread changes', () => {
  const { result, rerender } = renderHook(
    ({ threadId, messages }) => useKnownMessageIds(threadId, messages),
    { initialProps: { threadId: 'a', messages: first } },
  );

  rerender({ threadId: 'b', messages: grown });

  expect([...result.current]).toEqual(['m1', 't1', 'm2']);
});
