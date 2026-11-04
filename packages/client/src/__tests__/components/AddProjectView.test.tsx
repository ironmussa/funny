import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { err, ok } from 'neverthrow';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AddProjectView } from '@/components/AddProjectView';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  listProjects: vi.fn(),
  loadProjects: vi.fn(),
  toastError: vi.fn(),
  toast: vi.fn(),
  orgId: null as string | null,
}));
vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('@/stores/app-store', () => ({
  useAppStore: (select: (s: typeof mocks) => unknown) => select(mocks),
}));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ activeOrgId: mocks.orgId }) },
}));
vi.mock('@/lib/toast-error', () => ({ toastError: mocks.toastError }));
vi.mock('sonner', () => ({ toast: { error: mocks.toast, success: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/url', () => ({ buildPath: (path: string) => path }));
vi.mock('@/components/CloneRepoView', () => ({ CloneRepoView: () => null }));
vi.mock('@/components/FolderPicker', () => ({ FolderPicker: () => null }));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
}));
function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
function submit() {
  render(
    <MemoryRouter>
      <AddProjectView />
      <Location />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByTestId('add-project-name'), { target: { value: 'Broncos' } });
  fireEvent.change(screen.getByTestId('add-project-path'), { target: { value: '/repos/broncos' } });
  fireEvent.click(screen.getByTestId('add-project-submit'));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgId = null;
  mocks.createProject.mockResolvedValue(err({ type: 'CONFLICT', message: 'Already exists' }));
  mocks.loadProjects.mockResolvedValue(undefined);
});
afterEach(cleanup);
test('offers to open the existing project after refreshing the list', async () => {
  mocks.listProjects.mockResolvedValue(ok([{ id: 'p1', name: 'Broncos', path: '/repos/broncos' }]));
  submit();
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.listProjects).toHaveBeenCalledWith(null);
  expect(mocks.loadProjects).toHaveBeenCalled();
  expect(screen.getByTestId('location').textContent).toBe('/');
  act(() => mocks.toast.mock.calls[0][1].action.onClick());
  expect(screen.getByTestId('location').textContent).toBe('/projects/p1');
});
test('retains the error when no accessible existing project can be resolved', async () => {
  mocks.listProjects.mockResolvedValue(ok([]));
  submit();
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(screen.getByTestId('location').textContent).toBe('/');
});
