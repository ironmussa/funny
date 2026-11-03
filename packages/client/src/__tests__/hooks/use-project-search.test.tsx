import type { Project } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { act, renderHook } from '@testing-library/react';
import { err, ok, ResultAsync, type Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectSearch } from '@/hooks/use-project-search';
import { projectsApi } from '@/lib/api/projects';

vi.mock('@/lib/api/projects', () => ({ projectsApi: { listProjects: vi.fn() } }));
const list = vi.mocked(projectsApi.listProjects);
const project = { id: 'broncos', name: 'goliive-broncos', path: '/repos/broncos' } as Project;
async function tick(ms = 250) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  list.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('server project search', () => {
  it('finds a project from the server without a cached project list', async () => {
    list.mockResolvedValue(ok([project]));
    const { result } = renderHook(() => useProjectSearch(true, 'bron', null));
    expect(result.current.loading).toBe(true);
    await tick();
    expect(list).toHaveBeenCalledWith(null, 'bron', expect.any(AbortSignal));
    expect(result.current.projects).toEqual([project]);
    expect(result.current.loading).toBe(false);
  });

  it('debounces typing and ignores late responses from a previous space', async () => {
    let finish!: (value: Result<Project[], DomainError>) => void;
    list.mockImplementationOnce(
      () =>
        new ResultAsync(
          new Promise((resolve) => {
            finish = resolve;
          }),
        ),
    );
    const { result, rerender } = renderHook(
      ({ search, org }) => useProjectSearch(true, search, org),
      { initialProps: { search: 'b', org: 'old-org' } },
    );
    rerender({ search: 'bron', org: 'old-org' });
    await tick();
    expect(list).toHaveBeenCalledTimes(1);
    const signal = list.mock.calls[0][2]!;
    list.mockResolvedValue(ok([]));
    rerender({ search: 'bron', org: 'new-org' });
    expect(signal.aborted).toBe(true);
    await tick();
    await act(async () => {
      finish(ok([project]));
    });
    expect(result.current.projects).toEqual([]);
    expect(list).toHaveBeenLastCalledWith('new-org', 'bron', expect.any(AbortSignal));
  });

  it('reports a failed request instead of successful empty results', async () => {
    list.mockResolvedValue(err({ type: 'INTERNAL', message: 'Offline' }));
    const { result } = renderHook(() => useProjectSearch(true, 'bron', null));
    await tick();
    expect(result.current.error).toBe('Offline');
    expect(result.current.loading).toBe(false);
  });

  it('refreshes when reopened and cancels when closed', async () => {
    list.mockResolvedValue(ok([]));
    const { result, rerender } = renderHook(({ open }) => useProjectSearch(open, '', null), {
      initialProps: { open: false },
    });
    await tick();
    expect(list).not.toHaveBeenCalled();
    rerender({ open: true });
    await tick();
    const signal = list.mock.calls[0][2]!;
    rerender({ open: false });
    expect(signal.aborted).toBe(true);
    list.mockResolvedValue(ok([project]));
    rerender({ open: true });
    await tick();
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.projects).toEqual([project]);
  });
});
