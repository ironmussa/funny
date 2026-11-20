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
    // oxlint-disable-next-line shadcn/no-unknown-classes -- test fixture: not a real class
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  test('handles conditional classes', () => {
    // oxlint-disable-next-line shadcn/no-unknown-classes -- test fixture: not a real class
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  test('handles undefined and null', () => {
    // oxlint-disable-next-line shadcn/no-unknown-classes -- test fixture: not a real class
    expect(cn('base', undefined, null, 'end')).toBe('base end');
  });

  test('merges tailwind conflicts (last wins)', () => {
    expect(cn('p-4', 'p-2')).toBe('p-2');
  });

  test('merges tailwind color conflicts', () => {
    // oxlint-disable-next-line shadcn/no-raw-colors -- test fixture: verifying tailwind-merge behavior
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  test('keeps the text color next to a small text step', () => {
    expect(cn('text-muted-foreground', 'text-2xs')).toBe('text-muted-foreground text-2xs');
    expect(cn('text-compact', 'text-foreground')).toBe('text-compact text-foreground');
  });

  test('small text steps replace other font sizes', () => {
    expect(cn('text-xs', 'text-2xs')).toBe('text-2xs');
    expect(cn('text-3xs', 'text-compact')).toBe('text-compact');
  });

  test('preserves non-conflicting classes', () => {
    expect(cn('p-4', 'mt-2', 'flex')).toBe('p-4 mt-2 flex');
  });

  test('handles array inputs', () => {
    // oxlint-disable-next-line shadcn/no-unknown-classes -- test fixture: not a real class
    expect(cn(['foo', 'bar'])).toBe('foo bar');
  });

  test('handles empty inputs', () => {
    expect(cn()).toBe('');
  });

  test('handles object syntax', () => {
    expect(cn({ hidden: true, visible: false })).toBe('hidden');
  });

  test('combines all forms', () => {
    // oxlint-disable-next-line shadcn/no-unknown-classes -- test fixture: not a real class
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

/** A `DOMRect` at the left edge with the given vertical extent. */
function rect(box: Pick<DOMRect, 'top' | 'bottom' | 'width' | 'height'>): DOMRect {
  const full = { ...box, x: 0, y: box.top, left: 0, right: box.width };
  return { ...full, toJSON: () => full };
}

describe('scrollSidebarItemIntoView', () => {
  test('scrolls item below the top inset when block is start', () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientHeight', { value: 400 });
    root.scrollTo = vi.fn();

    const item = document.createElement('div');
    root.appendChild(item);
    root.getBoundingClientRect = () => rect({ top: 100, bottom: 500, width: 200, height: 400 });
    item.getBoundingClientRect = () => rect({ top: 180, bottom: 220, width: 200, height: 40 });

    scrollSidebarItemIntoView(root, item, 'start');

    expect(root.scrollTo).toHaveBeenCalledWith({
      top: Math.max(0, root.scrollTop + (180 - 100) - SIDEBAR_SCROLL_TOP_OFFSET),
      behavior: 'smooth',
    });
  });
});
