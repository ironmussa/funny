import { act, render, screen } from '@testing-library/react';
import { okAsync, ResultAsync } from 'neverthrow';
import { beforeEach, expect, test, vi } from 'vitest';

import { NewThreadContextBar } from '@/components/thread/NewThreadContextBar';
import { TooltipProvider } from '@/components/ui/tooltip';

const remote = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { projectGetRemoteUrl: remote } }));
vi.mock('@/hooks/use-branch-switch', () => ({
  useBranchSwitch: () => ({ ensureBranch: vi.fn(), branchSwitchDialog: null }),
}));
vi.mock('@/components/SearchablePicker', () => ({ BranchPicker: () => null }));
vi.mock('@/components/PromptInputUI', async () => await import('@/lib/git-remote-url'));
vi.mock('@/stores/project-store', () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({
      projects: ['one', 'two'].map((id) => ({ id, name: id, path: '/mnt/windows/repo' })),
    }),
}));
vi.mock('@/stores/branch-picker-store', () => ({
  useBranchPickerStore: (selector: (state: unknown) => unknown) => selector({ branches: [] }),
}));

function bar(projectId?: string) {
  return (
    <TooltipProvider>
      <NewThreadContextBar projectId={projectId} />
    </TooltipProvider>
  );
}

beforeEach(() => remote.mockReset());

test('loads a remote by project ID even outside HOME and cancels on unmount', async () => {
  remote.mockReturnValue(okAsync({ remoteUrl: 'https://github.com/acme/repo.git' }));
  const view = render(bar('one'));
  expect(await screen.findByTestId('new-thread-repo-link')).toHaveAttribute(
    'href',
    'https://github.com/acme/repo',
  );
  expect(remote).toHaveBeenCalledWith('one', expect.any(AbortSignal));
  const signal = remote.mock.calls[0][1] as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});

test('ignores a late response after changing project, including projects sharing a path', async () => {
  let resolve!: (value: { remoteUrl: string }) => void;
  remote.mockReturnValueOnce(
    ResultAsync.fromPromise(
      new Promise<{ remoteUrl: string }>((done) => {
        resolve = done;
      }),
      () => ({ message: 'failed' }),
    ),
  );
  const view = render(bar('one'));
  const signal = remote.mock.calls[0][1] as AbortSignal;
  remote.mockReturnValue(okAsync({ remoteUrl: 'https://github.com/acme/two.git' }));
  view.rerender(bar('two'));
  expect(signal.aborted).toBe(true);
  expect(await screen.findByTestId('new-thread-repo-link')).toHaveAttribute(
    'href',
    'https://github.com/acme/two',
  );
  await act(async () => resolve({ remoteUrl: 'https://github.com/acme/one.git' }));
  expect(screen.getByTestId('new-thread-repo-link')).toHaveAttribute(
    'href',
    'https://github.com/acme/two',
  );
});

test('does not request a remote without a project', () => {
  render(bar());
  expect(remote).not.toHaveBeenCalled();
});
