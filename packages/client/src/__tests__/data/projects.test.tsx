import type { Project } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { act, renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  deleteProject,
  renameProject,
  reorderProjects,
  updateProject,
} from '@/data/projects/actions';
import { useProjectById, useProjects } from '@/data/projects/hooks';
import { loadProjects, upsertProjects } from '@/data/projects/loaders';
import { readProject, readProjects } from '@/data/projects/read';
import { seedProjects } from '@/data/projects/testing';

import { deferred, installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  renameProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  reorderProjects: vi.fn(),
}));
vi.mock('@/lib/api/projects', () => ({ projectsApi: api }));

const effects = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@/platform/client-composition', () => ({
  clientComposition: { platform: { effects } },
}));

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    path: `/repo/${id}`,
    userId: 'u1',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const failure: DomainError = { type: 'INTERNAL', message: 'boom' };
const ids = (projects: Project[]) => projects.map((p) => p.id);

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('loadProjects', () => {
  test('keeps the server order and badges org projects', async () => {
    api.listProjects.mockReturnValue(
      okAsync([project('b', { sortOrder: 0 }), project('a', { sortOrder: 0 })]),
    );
    const result = await loadProjects({ orgId: 'org-1', orgName: 'Acme' });
    expect(result.isOk()).toBe(true);
    expect(ids(readProjects())).toEqual(['b', 'a']);
    expect(readProject('a')).toMatchObject({ isTeamProject: true, organizationName: 'Acme' });
  });

  test('a reload removes projects the server no longer lists', async () => {
    seedProjects([project('a'), project('gone')]);
    api.listProjects.mockReturnValue(okAsync([project('a')]));
    await loadProjects({ orgId: null });
    expect(ids(readProjects())).toEqual(['a']);
  });

  test('upsertProjects adds a search result at the end of the list', () => {
    seedProjects([project('a', { sortOrder: 0 })]);
    upsertProjects([project('found', { sortOrder: 0 })]);
    expect(ids(readProjects())).toEqual(['a', 'found']);
  });
});

describe('optimistic project writes', () => {
  beforeEach(() => seedProjects([project('p1', { name: 'Old' }), project('p2', { sortOrder: 1 })]));

  test('a rename shows in the same tick and keeps the server result', async () => {
    const gate = deferred<Project>();
    api.renameProject.mockReturnValue(ResultAsync.fromSafePromise(gate.promise));
    const pending = renameProject('p1', 'New');
    expect(readProject('p1')?.name).toBe('New');

    gate.resolve(project('p1', { name: 'New (server)' }));
    expect((await pending).isOk()).toBe(true);
    expect(readProject('p1')?.name).toBe('New (server)');
  });

  test('a failed update rolls back and shows a toast', async () => {
    api.updateProject.mockReturnValue(errAsync(failure));
    const result = await updateProject('p1', { color: '#fff' });
    expect(result.isErr()).toBe(true);
    expect(readProject('p1')?.color).toBeUndefined();
    expect(effects.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'toast', level: 'error' }),
    );
  });

  test('a delete removes the project at once and rolls back on failure', async () => {
    const gate = deferred<{ ok: boolean }>();
    api.deleteProject.mockReturnValue(
      new ResultAsync(gate.promise.then(() => errAsync(failure)).then((r) => r)),
    );
    const pending = deleteProject('p1');
    expect(ids(readProjects())).toEqual(['p2']);
    gate.resolve({ ok: true });
    expect((await pending).isErr()).toBe(true);
    expect(ids(readProjects())).toEqual(['p1', 'p2']);
  });

  test('spec: a failed reorder rolls back to the previous order', async () => {
    const gate = deferred<void>();
    api.reorderProjects.mockReturnValue(
      new ResultAsync(gate.promise.then(() => errAsync<void, DomainError>(failure))),
    );
    const pending = reorderProjects(['p2', 'p1']);
    expect(ids(readProjects())).toEqual(['p2', 'p1']);

    gate.resolve();
    expect((await pending).isErr()).toBe(true);
    expect(ids(readProjects())).toEqual(['p1', 'p2']);
  });

  test('a confirmed reorder keeps the new order', async () => {
    api.reorderProjects.mockReturnValue(okAsync(undefined));
    expect((await reorderProjects(['p2', 'p1'])).isOk()).toBe(true);
    expect(ids(readProjects())).toEqual(['p2', 'p1']);
  });
});

describe('project hooks', () => {
  test('useProjects and useProjectById follow optimistic writes', async () => {
    seedProjects([project('p1', { name: 'Old' }), project('p2', { sortOrder: 1 })]);
    const list = renderHook(() => useProjects());
    const one = renderHook(() => useProjectById('p1'));
    expect(ids(list.result.current)).toEqual(['p1', 'p2']);

    const gate = deferred<Project>();
    api.renameProject.mockReturnValue(ResultAsync.fromSafePromise(gate.promise));
    let pending!: ReturnType<typeof renameProject>;
    act(() => {
      pending = renameProject('p1', 'New');
    });
    await waitFor(() => expect(one.result.current?.name).toBe('New'));
    expect(Object.keys(one.result.current!).some((key) => key.startsWith('$'))).toBe(false);

    gate.resolve(project('p1', { name: 'New' }));
    await act(async () => {
      await pending;
    });
    expect(list.result.current.find((p) => p.id === 'p1')?.name).toBe('New');
  });
});
