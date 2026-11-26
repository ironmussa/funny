/**
 * The lanes section of project factory settings (openspec factory-lanes):
 * prefix inputs (disabled when lanes exist), lane rows (label, branch, state,
 * open runs, sync state/PR/error, CI warning, finish PR link), and actions
 * (sync/retry, finish lane, remove).
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import type { FactoryLane } from '@funny/shared/contracts/factory';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';

const mocks = ((): {
  lanes: FactoryLane[];
  remove: ReturnType<typeof vi.fn>;
  sync: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  toastError: ReturnType<typeof vi.fn>;
  toastSuccess: ReturnType<typeof vi.fn>;
  toastInfo: ReturnType<typeof vi.fn>;
} => ({
  lanes: [],
  remove: vi.fn(),
  sync: vi.fn(),
  finish: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}))();

mock.module('@/data/factory/hooks', () => ({
  useFactoryLanes: () => mocks.lanes,
}));
mock.module('@/data/factory/actions', () => ({
  removeFactoryLane: (...args: unknown[]) => mocks.remove(...args),
  syncFactoryLane: (...args: unknown[]) => mocks.sync(...args),
  finishFactoryLane: (...args: unknown[]) => mocks.finish(...args),
}));
mock.module('@/components/settings/SettingRow', () => ({ useSettingDimmed: () => false }));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
mock.module('@/lib/toast-error', () => ({
  toastError: (...args: unknown[]) => mocks.toastError(...args),
}));
mock.module('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    info: (...args: unknown[]) => mocks.toastInfo(...args),
  },
}));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string, vars?: Record<string, unknown>) =>
      (fallback ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars?.[name] ?? '')),
  }),
}));

import { ProjectFactoryLanes } from '@/components/general-settings-project/ProjectFactoryLanes';

const lane = (over: Partial<FactoryLane> = {}): FactoryLane => ({
  id: 'lane-1',
  name: 'billing',
  label: 'feature:billing',
  branch: 'feature/billing',
  state: 'active',
  openRuns: [],
  ciWarning: null,
  createdAt: '2026-11-25T00:00:00.000Z',
  syncState: 'idle',
  syncPrNumber: null,
  syncPrUrl: null,
  syncThreadId: null,
  syncAttempts: 0,
  syncStartedAt: null,
  syncError: null,
  lastSyncedBaseSha: null,
  finishPrNumber: null,
  finishPrUrl: null,
  conflicts: null,
  conflictsCheckedAt: null,
  conflictsNote: null,
  ...over,
});

beforeEach(() => {
  mocks.lanes = [];
  mocks.remove = vi.fn(() => okAsync({ ok: true }));
  mocks.sync = vi.fn(() => okAsync({ outcome: 'requested' }));
  mocks.finish = vi.fn(() =>
    okAsync({
      lane: 'billing',
      branch: 'feature/billing',
      base: 'main',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
    }),
  );
  mocks.toastError = vi.fn();
  mocks.toastSuccess = vi.fn();
  mocks.toastInfo = vi.fn();
});

describe('ProjectFactoryLanes', () => {
  test('edits prefixes when there are no lanes and explains the two labels', () => {
    const onSave = vi.fn();
    render(
      <ProjectFactoryLanes
        projectId="p1"
        label="ready-for-agent"
        laneLabelPrefix="feature:"
        laneBranchPrefix="feature/"
        rowKey="k1"
        onSave={onSave}
      />,
    );

    expect(screen.queryByTestId('settings-factory-lanes')).toBeNull();
    expect(screen.getByTestId('settings-factory-lanes-count')).toHaveTextContent('0');
    expect(screen.getAllByText(/ready-for-agent.*feature:<name>/).length).toBeGreaterThanOrEqual(1);

    const labelInput = screen.getByTestId('settings-factory-lane-label-prefix');
    const branchInput = screen.getByTestId('settings-factory-lane-branch-prefix');
    expect(labelInput).not.toBeDisabled();
    expect(branchInput).not.toBeDisabled();

    fireEvent.blur(labelInput, { target: { value: 'epic:' } });
    expect(onSave).toHaveBeenCalledWith({ laneLabelPrefix: 'epic:' });

    fireEvent.blur(branchInput, { target: { value: 'epic/' } });
    expect(onSave).toHaveBeenCalledWith({ laneBranchPrefix: 'epic/' });
  });

  test('renders lane metadata, sync state/PR/error, CI warning, finish PR link and disables prefixes', () => {
    mocks.lanes = [
      lane({
        openRuns: ['#12', '#13'],
        ciWarning: 'Workflow ci.yml only triggers on main',
        syncState: 'needs_human',
        syncPrNumber: 19,
        syncPrUrl: 'https://github.com/org/repo/pull/19',
        syncError: 'Merge commits are disabled on this repository',
        finishPrNumber: 42,
        finishPrUrl: 'https://github.com/org/repo/pull/42',
      }),
    ];

    render(
      <ProjectFactoryLanes
        projectId="p1"
        label="ready-for-agent"
        laneLabelPrefix="feature:"
        laneBranchPrefix="feature/"
        rowKey="k1"
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId('settings-factory-lane-label-prefix')).toBeDisabled();
    expect(screen.getByTestId('settings-factory-lane-branch-prefix')).toBeDisabled();
    expect(screen.getByTestId('settings-factory-lane-label-billing')).toHaveTextContent(
      'feature:billing',
    );
    expect(screen.getByTestId('settings-factory-lane-branch-billing')).toHaveTextContent(
      'feature/billing',
    );
    expect(screen.getByTestId('settings-factory-lane-state-billing')).toHaveTextContent('Active');
    expect(screen.getByTestId('settings-factory-lane-sync-state-billing')).toHaveTextContent(
      'Sync needs attention',
    );
    expect(screen.getByTestId('settings-factory-lane-open-runs-billing')).toHaveTextContent(
      '#12, #13',
    );
    expect(screen.getByTestId('settings-factory-lane-ci-warning-billing')).toHaveTextContent(
      'Workflow ci.yml only triggers on main',
    );
    expect(screen.getByTestId('settings-factory-lane-sync-error-billing')).toHaveTextContent(
      'Merge commits are disabled on this repository',
    );
    expect(screen.getByTestId('settings-factory-lane-sync-pr-billing')).toHaveAttribute(
      'href',
      'https://github.com/org/repo/pull/19',
    );
    expect(screen.getByTestId('settings-factory-lane-finish-pr-billing')).toHaveAttribute(
      'href',
      'https://github.com/org/repo/pull/42',
    );
    // Open runs disable Finish and Remove, while Retry sync remains available.
    expect(screen.getByTestId('settings-factory-lane-finish-billing')).toBeDisabled();
    expect(screen.getByTestId('settings-factory-lane-remove-billing')).toBeDisabled();
    expect(screen.getByTestId('settings-factory-lane-sync-billing')).toHaveTextContent(
      'Retry sync',
    );
  });

  // openspec factory-lanes D7: the daily cross-lane conflict check.
  test('shows the lanes a lane conflicts with and why a check could not run', () => {
    mocks.lanes = [
      lane({
        conflicts: [{ lane: 'search', paths: ['src/router.ts', 'src/app.ts'] }],
        conflictsCheckedAt: '2026-11-26T00:00:00.000Z',
      }),
      lane({
        id: 'lane-2',
        name: 'search',
        label: 'feature:search',
        branch: 'feature/search',
        conflicts: null,
        conflictsNote: 'git 2.38 or later is needed (found 2.34)',
      }),
    ];

    render(
      <ProjectFactoryLanes
        projectId="p1"
        label="ready-for-agent"
        laneLabelPrefix="feature:"
        laneBranchPrefix="feature/"
        rowKey="k1"
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId('settings-factory-lane-conflict-billing-search')).toHaveTextContent(
      'Conflicts with search on src/router.ts, src/app.ts',
    );
    expect(screen.getByTestId('settings-factory-lane-conflict-note-search')).toHaveTextContent(
      'git 2.38 or later is needed',
    );
    expect(screen.queryByTestId('settings-factory-lane-conflict-note-billing')).toBeNull();
  });

  test('triggers sync, finish lane, and remove actions and reports errors', async () => {
    mocks.lanes = [lane()];
    render(
      <ProjectFactoryLanes
        projectId="p1"
        label="ready-for-agent"
        laneLabelPrefix="feature:"
        laneBranchPrefix="feature/"
        rowKey="k1"
        onSave={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('settings-factory-lane-sync-billing'));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith('p1', 'billing'));
    expect(mocks.toastSuccess).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('settings-factory-lane-finish-billing'));
    await waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('p1', 'billing'));

    mocks.remove = vi.fn(() => errAsync({ type: 'CONFLICT', message: 'Lane has open runs' }));
    fireEvent.click(screen.getByTestId('settings-factory-lane-remove-billing'));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('p1', 'billing'));
    expect(mocks.toastError).toHaveBeenCalled();
  });
});
