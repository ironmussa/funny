import { describe, test, expect, vi } from 'vitest';

import {
  cn,
  deriveBranchFromWorktreePath,
  resolveLocalThreadBranch,
  resolveThreadBranch,
  scrollSidebarItemIntoView,
  SIDEBAR_SCROLL_TOP_OFFSET,
  TOAST_DURATION,
} from '@/lib/utils';

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

describe('deriveBranchFromWorktreePath', () => {
  test('converts first hyphen in folder name to slash', () => {
    expect(deriveBranchFromWorktreePath('/tmp/wt/myproj-feat-login-abc123')).toBe(
      'myproj/feat-login-abc123',
    );
  });

  test('returns folder name when there is no hyphen', () => {
    expect(deriveBranchFromWorktreePath('/tmp/wt/main')).toBe('main');
  });
});

describe('resolveThreadBranch', () => {
  test('prefers explicit branch', () => {
    expect(resolveThreadBranch({ branch: 'feat/x', worktreePath: '/wt/y' })).toBe('feat/x');
  });

  test('derives branch from worktree path when branch is missing', () => {
    expect(resolveThreadBranch({ branch: null, worktreePath: '/tmp/wt/proj-feat-abc' })).toBe(
      'proj/feat-abc',
    );
  });
});

describe('resolveLocalThreadBranch', () => {
  test('prefers branch over baseBranch', () => {
    expect(resolveLocalThreadBranch({ branch: 'feat/a', baseBranch: 'main' })).toBe('feat/a');
  });

  test('falls back to baseBranch when branch is null', () => {
    expect(resolveLocalThreadBranch({ branch: null, baseBranch: 'main' })).toBe('main');
  });
});

describe('scrollSidebarItemIntoView', () => {
  test('scrolls item below the top inset when block is start', () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientHeight', { value: 400 });
    root.scrollTo = vi.fn();

    const item = document.createElement('div');
    root.appendChild(item);
    root.getBoundingClientRect = () =>
      ({ top: 100, bottom: 500, left: 0, right: 200, width: 200, height: 400 }) as DOMRect;
    item.getBoundingClientRect = () =>
      ({ top: 180, bottom: 220, left: 0, right: 200, width: 200, height: 40 }) as DOMRect;

    scrollSidebarItemIntoView(root, item, 'start');

    expect(root.scrollTo).toHaveBeenCalledWith({
      top: Math.max(0, root.scrollTop + (180 - 100) - SIDEBAR_SCROLL_TOP_OFFSET),
      behavior: 'smooth',
    });
  });
});
