import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ok, err, type Ok } from 'neverthrow';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MissingProjectDirectoryDialog } from '@/components/MissingProjectDirectoryDialog';

const mocks = vi.hoisted(() => ({
  listBranches: vi.fn(),
  state: {
    projects: [{ id: 'p1', path: '/deleted/project' }],
    selectedProjectId: 'p1',
    revealNonce: 0,
  },
}));
vi.mock('@/lib/api/projects', () => ({ projectsApi: { listBranches: mocks.listBranches } }));
vi.mock('@/stores/project-store', () => ({
  useProjectStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/url', () => ({ buildPath: (path: string) => path }));

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
function View({ route = '/projects/p1' }: { route?: string }) {
  return (
    <MemoryRouter initialEntries={[route]}>
      <MissingProjectDirectoryDialog />
      <Location />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mocks.listBranches.mockReset();
  mocks.state.selectedProjectId = 'p1';
  mocks.state.revealNonce = 0;
});
afterEach(cleanup);

describe('MissingProjectDirectoryDialog', () => {
  test('offers configuration for a missing directory and opens project settings', async () => {
    mocks.listBranches.mockResolvedValue(ok({ directoryExists: false }));
    render(<View />);
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('projects.configureDirectory'));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/settings/general');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('cancel dismisses the notice without navigating', async () => {
    mocks.listBranches.mockResolvedValue(ok({ directoryExists: false }));
    render(<View />);
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('common.cancel'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1');
  });

  test.each([ok({ directoryExists: true }), ok({}), err({ message: 'Offline' })])(
    'does not report a missing directory without explicit confirmation',
    async (result) => {
      mocks.listBranches.mockResolvedValue(result);
      render(<View />);
      await act(async () => {});
      expect(screen.queryByRole('alertdialog')).toBeNull();
    },
  );

  test('does not interrupt settings', () => {
    render(<View route="/projects/p1/settings/general" />);
    expect(mocks.listBranches).not.toHaveBeenCalled();
  });

  test('ignores an outdated response after leaving the project', async () => {
    let resolve!: (value: Ok<{ directoryExists: boolean }, unknown>) => void;
    mocks.listBranches.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<View />);
    const signal = mocks.listBranches.mock.calls[0][1] as AbortSignal;
    mocks.state.selectedProjectId = '';
    view.rerender(<View />);
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolve(ok({ directoryExists: false }));
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});
