/**
 * The schedule triggers of a factory and "Run a flow" (change flow-triggers):
 * the list, the form (a flow that needs an issue or a required input left
 * empty cannot be saved), saving, removing, and starting a flow once.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';

import type { FactoryIssuelessFlow, FactoryTrigger } from '@/lib/api/factory';

const mocks = ((): {
  triggers: FactoryTrigger[];
  flows: Record<string, FactoryIssuelessFlow>;
  save: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  toastError: ReturnType<typeof vi.fn>;
} => ({
  triggers: [],
  flows: {},
  save: vi.fn(),
  remove: vi.fn(),
  run: vi.fn(),
  toastError: vi.fn(),
}))();

mock.module('@/data/factory/hooks', () => ({
  useFactoryTriggers: () => mocks.triggers,
  useFactoryFlows: () => [
    { name: 'audit', source: 'repository' },
    { name: 'issue-to-merge', source: 'built-in' },
  ],
  useFactoryIssuelessFlow: (_projectId: string, flowName: string) => ({
    flow: mocks.flows[flowName],
    error: null,
    loading: false,
  }),
}));
mock.module('@/data/factory/actions', () => ({
  saveFactoryTrigger: (...args: unknown[]) => mocks.save(...args),
  removeFactoryTrigger: (...args: unknown[]) => mocks.remove(...args),
  runFactoryFlow: (...args: unknown[]) => mocks.run(...args),
}));
mock.module('@/data/projects/hooks', () => ({
  useProjectById: () => ({ id: 'p1', name: 'funny' }),
}));
mock.module('@/components/settings/SettingRow', () => ({ useSettingDimmed: () => false }));
mock.module('@/lib/toast-error', () => ({
  toastError: (...args: unknown[]) => mocks.toastError(...args),
}));
mock.module('@/components/ui/toast', () => ({ toast: { success: vi.fn() } }));
// Radix Select needs layout APIs happy-dom lacks: a native select with the same test ids.
mock.module('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)} data-testid="flow-select">
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string, vars?: Record<string, unknown>) =>
      (fallback ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars?.[name] ?? '')),
  }),
}));

import { ProjectFactoryTriggers } from '@/components/general-settings-project/ProjectFactoryTriggers';

const AUDIT: FactoryIssuelessFlow = {
  inputs: [
    { name: 'scope', required: true, description: 'The area to audit' },
    { name: 'note', required: false, description: null },
  ],
  problems: [],
};

const nightly: FactoryTrigger = {
  id: 't1',
  name: 'Nightly audit',
  schedule: '0 3 * * *',
  flowName: 'audit',
  inputs: { scope: 'auth' },
  enabled: true,
  nextRunAt: '2026-11-24T03:00:00.000Z',
};

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

beforeEach(() => {
  mocks.triggers = [];
  mocks.flows = {
    audit: AUDIT,
    'issue-to-merge': {
      inputs: [],
      problems: [{ step: 'merge', field: 'merge', message: 'a merge step needs an issue' }],
    },
  };
  mocks.save = vi.fn(() => okAsync(nightly));
  mocks.remove = vi.fn(() => okAsync({ ok: true }));
  mocks.run = vi.fn(() => okAsync({ id: 'r1' }));
  mocks.toastError = vi.fn();
});

describe('schedule triggers', () => {
  test('lists each trigger with its schedule and flow; none shows no list', () => {
    const { unmount } = render(<ProjectFactoryTriggers projectId="p1" />);
    expect(screen.queryByTestId('settings-factory-triggers')).toBeNull();
    unmount();

    mocks.triggers = [nightly];
    render(<ProjectFactoryTriggers projectId="p1" />);
    const row = screen.getByTestId('settings-factory-trigger-t1');
    expect(row).toHaveTextContent('Nightly audit');
    expect(row).toHaveTextContent('0 3 * * *');
    expect(row).toHaveTextContent('audit');
  });

  test('a new schedule is saved with the typed inputs, the empty ones left out', async () => {
    render(<ProjectFactoryTriggers projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-trigger-add'));
    const save = screen.getByTestId('settings-factory-trigger-save');
    expect(save).toBeDisabled();

    type('settings-factory-trigger-name', 'Nightly audit');
    type('settings-factory-trigger-schedule', '0 3 * * *');
    type('flow-select', 'audit');
    // The required input is still empty.
    expect(save).toBeDisabled();
    type('settings-factory-trigger-input-scope', 'auth');
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledWith('p1', {
      name: 'Nightly audit',
      schedule: '0 3 * * *',
      flowName: 'audit',
      inputs: { scope: 'auth' },
      enabled: true,
    });
    await waitFor(() => expect(screen.queryByTestId('settings-factory-trigger-dialog')).toBeNull());
  });

  test('a flow that needs an issue says why and cannot be saved', () => {
    render(<ProjectFactoryTriggers projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-trigger-add'));
    type('settings-factory-trigger-name', 'Merge nightly');
    type('settings-factory-trigger-schedule', '0 3 * * *');
    type('flow-select', 'issue-to-merge');

    expect(screen.getByTestId('settings-factory-trigger-problems')).toHaveTextContent(
      'a merge step needs an issue',
    );
    expect(screen.getByTestId('settings-factory-trigger-save')).toBeDisabled();
  });

  test('a refused save keeps the dialog open and shows the server message', async () => {
    mocks.save = vi.fn(() => errAsync({ type: 'BAD_REQUEST', message: 'Invalid schedule' }));
    mocks.triggers = [nightly];
    render(<ProjectFactoryTriggers projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-trigger-edit-t1'));
    expect(screen.getByTestId('settings-factory-trigger-name')).toHaveValue('Nightly audit');

    fireEvent.click(screen.getByTestId('settings-factory-trigger-save'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0]![1]).toMatchObject({ id: 't1' });
    expect(screen.getByTestId('settings-factory-trigger-dialog')).toBeTruthy();
  });

  test('a trigger is removed', async () => {
    mocks.triggers = [nightly];
    render(<ProjectFactoryTriggers projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-trigger-remove-t1'));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('p1', 't1'));
  });
});

describe('run a flow', () => {
  test('a required input left empty cannot start; a typed one starts the flow', async () => {
    render(<ProjectFactoryTriggers projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-run-flow'));
    const start = screen.getByTestId('factory-run-flow-start');
    expect(start).toBeDisabled();

    type('flow-select', 'audit');
    expect(start).toBeDisabled();
    type('factory-run-flow-input-scope', 'billing');
    expect(start).not.toBeDisabled();

    fireEvent.click(start);
    await waitFor(() =>
      expect(mocks.run).toHaveBeenCalledWith('p1', 'audit', { scope: 'billing' }),
    );
    await waitFor(() => expect(screen.queryByTestId('factory-run-flow-dialog')).toBeNull());
  });

  test('a refused start keeps the dialog open and shows the server message', async () => {
    mocks.run = vi.fn(() =>
      errAsync({ type: 'CONFLICT', message: 'The issue factory is paused.' }),
    );
    render(<ProjectFactoryTriggers projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-run-flow'));
    type('flow-select', 'audit');
    type('factory-run-flow-input-scope', 'billing');

    fireEvent.click(screen.getByTestId('factory-run-flow-start'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('factory-run-flow-dialog')).toBeTruthy();
  });
});
