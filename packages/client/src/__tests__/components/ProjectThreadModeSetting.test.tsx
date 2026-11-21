import { beforeEach, describe, expect, test, vi, type Mock } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';

interface ThreadModeMocks {
  settings: null | {
    projectId: string;
    connectionId: string;
    sizeId: string;
    mode: 'local' | 'worktree' | 'sandbox';
  };
  sandboxReads: number;
  save: Mock<(...args: any[]) => any>;
}

const mocks = ((): ThreadModeMocks => ({
  settings: null,
  sandboxReads: 0,
  save: vi.fn(),
}))();

vi.mock('@/data/projects/hooks', () => ({ useCanSteerProject: () => true }));
vi.mock('@/data/runner/hooks', () => ({
  useProjectSandbox: () => {
    mocks.sandboxReads += 1;
    return {
      loading: false,
      sandbox: mocks.settings ? { settings: mocks.settings, connection: undefined } : null,
    };
  },
}));
vi.mock('@/data/runner/actions', () => ({ saveProjectSandbox: mocks.save }));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (select: (s: { user: { id: string } }) => unknown) =>
    select({ user: { id: 'alice' } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

import { ProjectThreadModeSetting } from '@/components/general-settings-project/ProjectThreadModeSetting';

const configured = (mode: 'local' | 'worktree' | 'sandbox', connectionId: string | '' = 'c1') => ({
  projectId: 'p1',
  connectionId,
  sizeId: 'large',
  mode,
});

function renderRow() {
  return render(<ProjectThreadModeSetting projectId="p1" />);
}

const pressed = (mode: string) =>
  screen.getByTestId(`settings-thread-mode-${mode}`).getAttribute('aria-pressed');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = null;
  mocks.sandboxReads = 0;
  mocks.save.mockReturnValue(okAsync(null));
});

describe('ProjectThreadModeSetting', () => {
  test('every member sees the three modes; worktree reflects their row', () => {
    mocks.settings = configured('worktree');
    renderRow();
    expect(screen.getByTestId('settings-thread-mode-sandbox')).toBeInTheDocument();
    expect(pressed('worktree')).toBe('true');
  });

  test('with no runtime row the default is local', () => {
    renderRow();
    expect(pressed('local')).toBe('true');
  });

  test('the sandbox option is disabled without a connection', () => {
    mocks.settings = configured('local', '');
    renderRow();
    expect(screen.getByTestId('settings-thread-mode-sandbox')).toBeDisabled();
    expect(pressed('local')).toBe('true');
  });

  test('choosing worktree saves the runtime mode', () => {
    mocks.settings = configured('local');
    renderRow();
    fireEvent.click(screen.getByTestId('settings-thread-mode-worktree'));
    expect(mocks.save).toHaveBeenCalledWith('p1', {
      mode: 'worktree',
      connectionId: 'c1',
      sizeId: 'large',
    });
  });

  test('choosing sandbox saves sandbox mode with the connection', () => {
    mocks.settings = configured('local');
    renderRow();
    fireEvent.click(screen.getByTestId('settings-thread-mode-sandbox'));
    expect(mocks.save).toHaveBeenCalledWith('p1', {
      mode: 'sandbox',
      connectionId: 'c1',
      sizeId: 'large',
    });
  });

  test('a sandbox runtime shows as selected', () => {
    mocks.settings = configured('sandbox');
    renderRow();
    expect(pressed('sandbox')).toBe('true');
    expect(pressed('local')).toBe('false');
  });
});
