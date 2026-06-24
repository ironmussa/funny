import { okAsync, ResultAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useBranchPickerStore } from '@/stores/branch-picker-store';

const mockListBranches = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/projects', () => ({
  projectsApi: {
    listBranches: mockListBranches,
  },
}));

describe('useBranchPickerStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBranchPickerStore.getState().reset();
  });

  test('prefers the requested branch when it is local', async () => {
    mockListBranches.mockReturnValueOnce(
      okAsync({
        branches: ['main', 'feature/pr-branch'],
        remoteBranches: [],
        defaultBranch: 'main',
        currentBranch: 'main',
      }),
    );

    await useBranchPickerStore.getState().fetchBranches('project-1', 'main', 'feature/pr-branch');

    expect(useBranchPickerStore.getState().selectedBranch).toBe('feature/pr-branch');
  });

  test('prefers the requested branch when it is remote-only', async () => {
    mockListBranches.mockReturnValueOnce(
      okAsync({
        branches: ['main'],
        remoteBranches: ['feature/pr-branch'],
        defaultBranch: 'main',
        currentBranch: 'main',
      }),
    );

    await useBranchPickerStore.getState().fetchBranches('project-1', 'main', 'feature/pr-branch');

    expect(useBranchPickerStore.getState().selectedBranch).toBe('feature/pr-branch');
  });

  test('matches prefixed remote branches by short PR branch name', async () => {
    mockListBranches.mockReturnValueOnce(
      okAsync({
        branches: ['main'],
        remoteBranches: ['origin/feature/pr-branch'],
        defaultBranch: 'main',
        currentBranch: 'main',
      }),
    );

    await useBranchPickerStore.getState().fetchBranches('project-1', 'main', 'feature/pr-branch');

    const state = useBranchPickerStore.getState();
    expect(state.remoteBranches).toEqual(['feature/pr-branch']);
    expect(state.selectedBranch).toBe('feature/pr-branch');
  });

  test('does not keep the previous selection while loading a preferred branch', async () => {
    let resolveBranches: (value: {
      branches: string[];
      remoteBranches: string[];
      defaultBranch: string | null;
      currentBranch: string | null;
    }) => void = () => {};
    const branchesPromise = new Promise<{
      branches: string[];
      remoteBranches: string[];
      defaultBranch: string | null;
      currentBranch: string | null;
    }>((resolve) => {
      resolveBranches = resolve;
    });
    mockListBranches.mockReturnValueOnce(ResultAsync.fromSafePromise(branchesPromise));
    useBranchPickerStore.setState({ selectedBranch: 'first-created-branch' });

    const fetchPromise = useBranchPickerStore
      .getState()
      .fetchBranches('project-1', 'main', 'feature/second-pr');

    expect(useBranchPickerStore.getState().selectedBranch).toBe('feature/second-pr');

    resolveBranches({
      branches: ['main'],
      remoteBranches: ['feature/second-pr'],
      defaultBranch: 'main',
      currentBranch: 'first-created-branch',
    });
    await fetchPromise;

    expect(useBranchPickerStore.getState().selectedBranch).toBe('feature/second-pr');
  });
});
