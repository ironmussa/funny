import { describe, test, expect } from 'vitest';

import { cn, TOAST_DURATION } from '@/lib/utils';

describe('cn utility', () => {
  test('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  test('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  test('handles undefined and null', () => {
    expect(cn('base', undefined, null, 'end')).toBe('base end');
  });

  test('merges tailwind conflicts (last wins)', () => {
    expect(cn('p-4', 'p-2')).toBe('p-2');
  });

  test('merges tailwind color conflicts', () => {
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  test('preserves non-conflicting classes', () => {
    expect(cn('p-4', 'mt-2', 'flex')).toBe('p-4 mt-2 flex');
  });

  test('handles array inputs', () => {
    expect(cn(['foo', 'bar'])).toBe('foo bar');
  });

  test('handles empty inputs', () => {
    expect(cn()).toBe('');
  });

  test('handles object syntax', () => {
    expect(cn({ hidden: true, visible: false })).toBe('hidden');
  });

  test('combines all forms', () => {
    const result = cn('base', ['arr1', 'arr2'], { conditional: true }, undefined);
    expect(result).toContain('base');
    expect(result).toContain('arr1');
    expect(result).toContain('arr2');
    expect(result).toContain('conditional');
  });
});

describe('TOAST_DURATION', () => {
  test('is 5000ms', () => {
    expect(TOAST_DURATION).toBe(5000);
  });
});
