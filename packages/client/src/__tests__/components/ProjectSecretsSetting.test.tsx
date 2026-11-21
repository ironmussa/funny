import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

import type { ProjectSecretSummary } from '@/lib/api/project-secrets';

interface SecretMocks {
  secrets: ProjectSecretSummary[] | undefined;
  set: Mock;
  remove: Mock;
  toastError: Mock;
  canManage: boolean;
  canSteer: boolean;
}

const mocks = vi.hoisted((): SecretMocks => ({
  secrets: [],
  set: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  canManage: true,
  canSteer: true,
}));

vi.mock('@/data/projects/hooks', () => ({
  useCanManageProject: () => mocks.canManage,
  useCanSteerProject: () => mocks.canSteer,
}));
vi.mock('@/data/project-secrets/hooks', () => ({ useProjectSecrets: () => mocks.secrets }));
vi.mock('@/data/project-secrets/actions', () => ({
  setProjectSecret: (input: unknown) => mocks.set(input),
  deleteProjectSecret: (...args: unknown[]) => mocks.remove(...args),
}));
vi.mock('@/lib/toast-error', () => ({ toastError: mocks.toastError }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string, vars?: Record<string, unknown>) =>
      (fallback ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars?.[name] ?? '')),
  }),
}));

import { ProjectSecretsSetting } from '@/components/general-settings-project/ProjectSecretsSetting';

const VALUE = 'value-that-must-not-be-rendered';

const secret = (over: Partial<ProjectSecretSummary> = {}): ProjectSecretSummary => ({
  id: 's1',
  name: 'API_KEY',
  scope: 'project',
  allowInSandbox: false,
  updatedBy: 'alice',
  updatedAt: '2026-11-20T00:00:00.000Z',
  ...over,
});

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
const valueField = () => screen.getByTestId<HTMLInputElement>('settings-secret-value');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.secrets = [];
  mocks.canManage = true;
  mocks.canSteer = true;
  mocks.set.mockReturnValue(okAsync(secret()));
  mocks.remove.mockReturnValue(okAsync(undefined));
});

describe('ProjectSecretsSetting', () => {
  test('shows both lists, empty, with the two notices', () => {
    render(<ProjectSecretsSetting projectId="p1" />);
    expect(screen.getByTestId('settings-secrets-empty-project')).toBeInTheDocument();
    expect(screen.getByTestId('settings-secrets-empty-user')).toBeInTheDocument();
    expect(screen.getByTestId('settings-secrets-notice-readers')).toHaveTextContent(
      'can read a shared secret',
    );
    expect(screen.getByTestId('settings-secrets-notice-redaction')).toHaveTextContent(
      'best effort',
    );
  });

  test('adds a shared secret and renders no value afterwards', async () => {
    render(<ProjectSecretsSetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-secret-add-project'));
    expect(valueField().type).toBe('password');

    type('settings-secret-name', 'API_KEY');
    type('settings-secret-value', VALUE);
    fireEvent.click(screen.getByTestId('settings-secret-allow-sandbox'));
    fireEvent.click(screen.getByTestId('settings-secret-save'));

    await waitFor(() => expect(screen.queryByTestId('settings-secret-dialog')).toBeNull());
    expect(mocks.set).toHaveBeenCalledWith({
      projectId: 'p1',
      scope: 'project',
      name: 'API_KEY',
      value: VALUE,
      allowInSandbox: true,
    });
    expect(document.body.innerHTML).not.toContain(VALUE);
  });

  test('a reserved name shows the inline error and cannot be saved', () => {
    render(<ProjectSecretsSetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-secret-add-user'));
    type('settings-secret-name', 'NODE_OPTIONS');
    type('settings-secret-value', VALUE);

    expect(screen.getByTestId('settings-secret-name-error')).toHaveTextContent('reserved');
    expect(screen.getByTestId('settings-secret-save')).toBeDisabled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  test('a new secret needs a value', () => {
    render(<ProjectSecretsSetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-secret-add-user'));
    type('settings-secret-name', 'MINE');
    expect(screen.getByTestId('settings-secret-save')).toBeDisabled();
  });

  test('replacing starts from an empty value, keeps the name fixed and sends no value when left empty', async () => {
    mocks.secrets = [secret()];
    render(<ProjectSecretsSetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-secret-replace-project-API_KEY'));

    const name = screen.getByTestId<HTMLInputElement>('settings-secret-name');
    expect(name.value).toBe('API_KEY');
    expect(name.readOnly).toBe(true);
    expect(valueField().value).toBe('');
    expect(valueField().placeholder).toBe('Stored, type a new value to replace');

    fireEvent.click(screen.getByTestId('settings-secret-allow-sandbox'));
    fireEvent.click(screen.getByTestId('settings-secret-save'));
    await waitFor(() => expect(mocks.set).toHaveBeenCalled());
    expect(mocks.set).toHaveBeenCalledWith({
      projectId: 'p1',
      scope: 'project',
      name: 'API_KEY',
      allowInSandbox: true,
    });
  });

  test('a refused save keeps the dialog open with the typed value', async () => {
    mocks.set.mockReturnValue(errAsync({ type: 'FORBIDDEN', message: 'no' }));
    render(<ProjectSecretsSetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-secret-add-user'));
    type('settings-secret-name', 'MINE');
    type('settings-secret-value', VALUE);
    fireEvent.click(screen.getByTestId('settings-secret-save'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(screen.getByTestId('settings-secret-dialog')).toBeInTheDocument();
    expect(valueField().value).toBe(VALUE);
  });

  test('the value field is kept away from password managers; multi-line says it is not masked', () => {
    render(<ProjectSecretsSetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-secret-add-user'));
    expect(valueField().getAttribute('autocomplete')).toBe('off');
    expect(valueField().hasAttribute('data-1p-ignore')).toBe(true);
    expect(valueField().getAttribute('data-lpignore')).toBe('true');

    fireEvent.click(screen.getByTestId('settings-secret-reveal'));
    expect(valueField().type).toBe('text');

    fireEvent.click(screen.getByTestId('settings-secret-multiline'));
    expect(screen.getByTestId('settings-secret-value').tagName).toBe('TEXTAREA');
    expect(screen.getByTestId('settings-secret-unmasked')).toBeInTheDocument();
  });

  test('the sandbox switch saves without a value', async () => {
    mocks.secrets = [secret()];
    render(<ProjectSecretsSetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-secret-sandbox-project-API_KEY'));
    await waitFor(() =>
      expect(mocks.set).toHaveBeenCalledWith({
        projectId: 'p1',
        scope: 'project',
        name: 'API_KEY',
        allowInSandbox: true,
      }),
    );
  });

  test('shared controls are disabled without manage; personal ones stay enabled', () => {
    mocks.canManage = false;
    mocks.secrets = [secret(), secret({ id: 's2', name: 'MINE', scope: 'user' })];
    render(<ProjectSecretsSetting projectId="p1" />);

    for (const id of [
      'settings-secret-add-project',
      'settings-secret-sandbox-project-API_KEY',
      'settings-secret-replace-project-API_KEY',
      'settings-secret-delete-project-API_KEY',
    ]) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
    for (const id of [
      'settings-secret-add-user',
      'settings-secret-sandbox-user-MINE',
      'settings-secret-replace-user-MINE',
      'settings-secret-delete-user-MINE',
    ]) {
      expect(screen.getByTestId(id)).toBeEnabled();
    }
  });

  test('a viewer cannot change personal secrets either', () => {
    mocks.canManage = false;
    mocks.canSteer = false;
    render(<ProjectSecretsSetting projectId="p1" />);
    expect(screen.getByTestId('settings-secret-add-user')).toBeDisabled();
  });

  test('a name in both lists is badged on both rows', () => {
    mocks.secrets = [
      secret({ name: 'DATABASE_URL' }),
      secret({ id: 's2', name: 'DATABASE_URL', scope: 'user' }),
      secret({ id: 's3', name: 'OTHER' }),
    ];
    render(<ProjectSecretsSetting projectId="p1" />);
    expect(screen.getByTestId('settings-secret-override-project-DATABASE_URL')).toHaveTextContent(
      'Overridden by yours',
    );
    expect(screen.getByTestId('settings-secret-override-user-DATABASE_URL')).toHaveTextContent(
      'Overrides shared',
    );
    expect(screen.queryByTestId('settings-secret-override-project-OTHER')).toBeNull();
  });

  test('deleting says what changes, and names the shared fallback for an override', async () => {
    mocks.secrets = [
      secret({ name: 'DATABASE_URL' }),
      secret({ id: 's2', name: 'DATABASE_URL', scope: 'user' }),
    ];
    render(<ProjectSecretsSetting projectId="p1" />);

    fireEvent.click(screen.getByTestId('settings-secret-delete-project-DATABASE_URL'));
    expect(
      await screen.findByText('Agents started from now on will not get DATABASE_URL.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(mocks.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('settings-secret-delete-user-DATABASE_URL'));
    expect(
      await screen.findByText('Your agents will get the shared value of DATABASE_URL again.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('p1', 's2'));
  });
});
