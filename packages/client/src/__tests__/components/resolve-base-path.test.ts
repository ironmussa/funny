import { describe, test, expect } from 'vitest';

import { resolveBasePath } from '@/components/review-pane/resolve-base-path';

const PROJECTS = [
  { id: 'p1', path: '/home/u/projects/funny' },
  { id: 'p2', path: '/home/u/projects/other' },
];

describe('resolveBasePath', () => {
  test('prefers the heavy-map worktree path when present', () => {
    expect(
      resolveBasePath({
        worktreePath: '/home/u/.wt/funny/feature-x',
        lightThread: { worktreePath: '/stale', projectId: 'p1' },
        threadProjectId: 'p1',
        selectedProjectId: 'p2',
        projects: PROJECTS,
      }),
    ).toBe('/home/u/.wt/funny/feature-x');
  });

  // Regression: on a fresh thread click the heavy `threadDataById` map lags
  // ~1-2s, so worktreePath/threadProjectId are undefined. The lightweight
  // `threadsById` index must fill the gap instead of collapsing to ''.
  test('falls back to the lightweight thread worktree path while heavy data lags', () => {
    expect(
      resolveBasePath({
        worktreePath: undefined,
        lightThread: { worktreePath: '/home/u/.wt/funny/feature-x', projectId: 'p1' },
        threadProjectId: undefined,
        selectedProjectId: null,
        projects: PROJECTS,
      }),
    ).toBe('/home/u/.wt/funny/feature-x');
  });

  test('falls back to the lightweight thread projectId for a local thread while heavy data lags', () => {
    expect(
      resolveBasePath({
        worktreePath: undefined,
        lightThread: { worktreePath: null, projectId: 'p1' },
        threadProjectId: undefined,
        selectedProjectId: null,
        projects: PROJECTS,
      }),
    ).toBe('/home/u/projects/funny');
  });

  test('uses the sidebar-selected project when no thread context exists (project mode)', () => {
    expect(
      resolveBasePath({
        worktreePath: undefined,
        lightThread: null,
        threadProjectId: undefined,
        selectedProjectId: 'p2',
        projects: PROJECTS,
      }),
    ).toBe('/home/u/projects/other');
  });

  test("returns '' when nothing resolves (caller must treat as not-ready)", () => {
    expect(
      resolveBasePath({
        worktreePath: undefined,
        lightThread: null,
        threadProjectId: undefined,
        selectedProjectId: null,
        projects: PROJECTS,
      }),
    ).toBe('');
  });

  test("returns '' when the resolved project id is not in the project list", () => {
    expect(
      resolveBasePath({
        worktreePath: undefined,
        lightThread: { worktreePath: null, projectId: 'ghost' },
        threadProjectId: undefined,
        selectedProjectId: null,
        projects: PROJECTS,
      }),
    ).toBe('');
  });
});
