import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync, ResultAsync } from 'neverthrow';
import { beforeEach, expect, test, vi } from 'vitest';

import { NewThreadContextBar } from '@/components/thread/NewThreadContextBar';
import { TooltipProvider } from '@/components/ui/tooltip';

const remote = vi.hoisted(() => vi.fn());
const branchState = vi.hoisted(() => ({
  branches: ['main', 'develop'],
  remoteBranches: [],
  defaultBranch: 'main',
  loading: false,
  selectedBranch: 'main',
  currentBranch: 'main',
  setSelectedBranch: vi.fn(),
}));
const ensureBranch = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    measure: vi.fn(),
    scrollToIndex: vi.fn(),
    getTotalSize: () => 0,
    getVirtualItems: () => [],
  }),
}));
vi.mock('@/lib/api', () => ({ api: { projectGetRemoteUrl: remote } }));
vi.mock('@/hooks/use-branch-switch', () => ({
  useBranchSwitch: () => ({ ensureBranch, branchSwitchDialog: null }),
}));
vi.mock('@/components/PromptInputUI', async () => await import('@/lib/git-remote-url'));
vi.mock('@/stores/project-store', () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({
      projects: ['one', 'two'].map((id) => ({ id, name: id, path: '/mnt/windows/repo' })),
    }),
}));
vi.mock('@/stores/branch-picker-store', () => ({
  useBranchPickerStore: (selector: (state: unknown) => unknown) => selector(branchState),
}));

function bar(projectId?: string) {
  return (
    <TooltipProvider>
      <NewThreadContextBar projectId={projectId} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  remote.mockReset();
  remote.mockReturnValue(okAsync({ remoteUrl: null }));
  ensureBranch.mockReset().mockResolvedValue(true);
  branchState.setSelectedBranch.mockReset();
  branchState.selectedBranch = 'main';
});

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

test('powerline branch trigger opens the picker and checks out before updating selection', async () => {
  render(bar('one'));
  const trigger = screen.getByTestId('new-thread-branch-picker');
  expect(trigger.tagName).toBe('BUTTON');
  expect(trigger).not.toHaveAttribute('tabindex', '-1');
  fireEvent.click(trigger);
  const search = await screen.findByRole('textbox');
  fireEvent.change(search, { target: { value: 'develop' } });
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  fireEvent.keyDown(search, { key: 'Enter' });
  await waitFor(() => expect(ensureBranch).toHaveBeenCalledWith('one', 'develop'));
  await waitFor(() => expect(branchState.setSelectedBranch).toHaveBeenCalledWith('develop'));
});

test('keeps the selected branch when checkout is cancelled', async () => {
  ensureBranch.mockResolvedValue(false);
  render(bar('one'));
  fireEvent.click(screen.getByTestId('new-thread-branch-picker'));
  const search = await screen.findByRole('textbox');
  fireEvent.change(search, { target: { value: 'develop' } });
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  fireEvent.keyDown(search, { key: 'Enter' });
  await waitFor(() => expect(ensureBranch).toHaveBeenCalledWith('one', 'develop'));
  expect(branchState.setSelectedBranch).not.toHaveBeenCalled();
  expect(screen.getByTestId('new-thread-branch-picker')).toHaveTextContent('main');
});

test('omits the remote segment for a local-only project', async () => {
  render(bar('one'));
  await waitFor(() => expect(remote).toHaveBeenCalled());
  expect(screen.queryByTestId('new-thread-repo-link')).not.toBeInTheDocument();
  expect(screen.getByTestId('powerline-segment-project')).toHaveTextContent('one');
});
