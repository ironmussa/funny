import type { WSCloneProgressData } from '@funny/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { err, ok } from 'neverthrow';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { CloneRepoView } from '@/components/CloneRepoView';

/**
 * Regression: the clone used to finish inside the HTTP request, so a large
 * repository hit the server's 30 s runner timeout and the view showed an error
 * while git kept cloning. The request now only starts the clone; the view
 * finishes on the clone's last `clone:progress` event.
 */

const mocks = vi.hoisted(() => ({
  api: {
    githubStatus: vi.fn(),
    githubUser: vi.fn(),
    githubRepos: vi.fn(),
    cloneRepo: vi.fn(),
  },
  loadProjects: vi.fn(),
  setAddProjectOpen: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastFailure: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks.api }));
interface AppStoreSlice {
  loadProjects: typeof mocks.loadProjects;
  setAddProjectOpen: typeof mocks.setAddProjectOpen;
}
interface UIStoreSlice {
  generalSettingsOpen: boolean;
}
vi.mock('@/stores/app-store', () => ({
  useAppStore: (select: (s: AppStoreSlice) => unknown) =>
    select({ loadProjects: mocks.loadProjects, setAddProjectOpen: mocks.setAddProjectOpen }),
}));
vi.mock('@/stores/ui-store', () => ({
  useUIStore: (select: (s: UIStoreSlice) => unknown) => select({ generalSettingsOpen: false }),
}));
vi.mock('@/lib/toast-error', () => ({ toastError: mocks.toastError }));
vi.mock('sonner', () => ({
  toast: { error: mocks.toastFailure, success: mocks.toastSuccess },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: () => null,
}));
vi.mock('@/lib/url', () => ({ buildPath: (path: string) => path }));
vi.mock('@/components/FolderPicker', () => ({ FolderPicker: () => null }));

const REPO = {
  id: 7,
  name: 'widget',
  full_name: 'acme/widget',
  description: null,
  private: false,
  clone_url: 'https://github.com/acme/widget.git',
  html_url: 'https://github.com/acme/widget',
  updated_at: new Date().toISOString(),
  stargazers_count: 0,
  language: null,
  default_branch: 'main',
  owner: { login: 'acme', avatar_url: '' },
};

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

async function startClone(): Promise<string> {
  render(
    <MemoryRouter>
      <CloneRepoView />
      <Location />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByTestId(`clone-repo-item-${REPO.id}`));
  fireEvent.change(screen.getByTestId('clone-config-destination'), {
    target: { value: '/home/me/code' },
  });
  fireEvent.click(screen.getByTestId('clone-config-submit'));
  await waitFor(() => expect(mocks.api.cloneRepo).toHaveBeenCalledTimes(1));
  return mocks.api.cloneRepo.mock.calls[0][3];
}

function progress(data: WSCloneProgressData) {
  act(() => {
    window.dispatchEvent(new CustomEvent('clone:progress', { detail: data }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no IntersectionObserver (the repo list's infinite scroll).
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.api.githubStatus.mockResolvedValue(ok({ connected: true, source: 'profile' }));
  mocks.api.githubUser.mockResolvedValue(ok({ login: 'me', avatar_url: '', name: null }));
  mocks.api.githubRepos.mockResolvedValue(ok({ repos: [REPO], hasMore: false }));
  mocks.loadProjects.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('sends its cloneId and waits for the done event to open the project', async () => {
  mocks.api.cloneRepo.mockResolvedValue(ok({ cloneId: 'ignored' }));

  const cloneId = await startClone();

  expect(mocks.api.cloneRepo).toHaveBeenCalledWith(
    REPO.clone_url,
    '/home/me/code',
    'widget',
    cloneId,
  );
  // Started, not finished: no success yet.
  expect(mocks.toastSuccess).not.toHaveBeenCalled();
  expect(mocks.loadProjects).not.toHaveBeenCalled();

  // Another clone's events are not this view's.
  progress({ cloneId: 'other', phase: 'Clone complete', status: 'done', projectId: 'p-x' });
  expect(mocks.toastSuccess).not.toHaveBeenCalled();

  progress({ cloneId, phase: 'Clone complete', percent: 100, status: 'done', projectId: 'p-1' });

  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/projects/p-1'));
  expect(mocks.toastSuccess).toHaveBeenCalledWith('github.clone.success');
  expect(mocks.loadProjects).toHaveBeenCalled();
  expect(mocks.setAddProjectOpen).toHaveBeenCalledWith(false);
});

test('shows the error and returns to the form on the failed event', async () => {
  mocks.api.cloneRepo.mockResolvedValue(ok({ cloneId: 'ignored' }));

  const cloneId = await startClone();
  progress({ cloneId, phase: 'Clone failed', status: 'failed', error: 'early EOF' });

  await waitFor(() => expect(mocks.toastFailure).toHaveBeenCalledWith('github.clone.failed'));
  expect(await screen.findByTestId('clone-config-submit')).toBeTruthy();
  expect(mocks.loadProjects).not.toHaveBeenCalled();
});

test('returns to the form when the clone cannot start', async () => {
  mocks.api.cloneRepo.mockResolvedValue(
    err({ type: 'CONFLICT', message: 'A clone into /home/me/code/widget is already running' }),
  );

  await startClone();

  expect(await screen.findByTestId('clone-config-submit')).toBeTruthy();
  expect(mocks.toastError).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'CONFLICT' }),
    'cloneRepo',
  );
});

test('a retried clone opens the form filled from the failed activity and starts nothing', async () => {
  render(
    <MemoryRouter>
      <CloneRepoView
        initialValues={{
          cloneUrl: 'https://github.com/acme/widget.git',
          destinationPath: '/home/me/code',
          name: 'widget',
        }}
      />
    </MemoryRouter>,
  );
  const destination = (await screen.findByTestId('clone-config-destination')) as HTMLInputElement;
  expect(destination.value).toBe('/home/me/code');
  expect(screen.getByText('acme/widget')).toBeInTheDocument();
  expect(mocks.api.cloneRepo).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId('clone-config-submit'));
  await waitFor(() => expect(mocks.api.cloneRepo).toHaveBeenCalledTimes(1));
  expect(mocks.api.cloneRepo.mock.calls[0].slice(0, 3)).toEqual([
    'https://github.com/acme/widget.git',
    '/home/me/code',
    'widget',
  ]);
});
