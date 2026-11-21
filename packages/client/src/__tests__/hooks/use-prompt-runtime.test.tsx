import { describe, expect, test, vi } from 'bun:test';

import { act, renderHook } from '@testing-library/react';

vi.mock('@/data/runner/hooks', () => ({
  useProjectSandbox: () => ({ loading: false, sandbox: null }),
}));

import { usePromptRuntime } from '@/hooks/use-prompt-model-state';

const render = (initialProps: { projectId: string; defaultThreadMode: string }) =>
  renderHook(
    ({ projectId, defaultThreadMode }) =>
      usePromptRuntime({
        isNewThread: true,
        projectId,
        launcherUrl: null,
        defaultThreadMode,
      }),
    { initialProps },
  );

describe('composer worktree toggle (project-runtime-settings)', () => {
  test('follows the runtime row when it arrives after the first render', () => {
    // The row is still loading: the hook reports `local` until it lands.
    const { result, rerender } = render({ projectId: 'p1', defaultThreadMode: 'local' });
    expect(result.current.createWorktree).toBe(false);
    rerender({ projectId: 'p1', defaultThreadMode: 'worktree' });
    expect(result.current.createWorktree).toBe(true);
  });

  test("the user's choice wins for that project only", () => {
    const { result, rerender } = render({ projectId: 'p1', defaultThreadMode: 'worktree' });
    act(() => result.current.setCreateWorktree(false));
    expect(result.current.createWorktree).toBe(false);
    rerender({ projectId: 'p2', defaultThreadMode: 'worktree' });
    expect(result.current.createWorktree).toBe(true);
    rerender({ projectId: 'p1', defaultThreadMode: 'worktree' });
    expect(result.current.createWorktree).toBe(false);
  });
});
