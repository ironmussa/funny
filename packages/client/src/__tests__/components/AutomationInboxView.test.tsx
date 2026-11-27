import { beforeEach, describe, expect, test, mock } from 'bun:test';

import type { Automation, InboxItem } from '@funny/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { seedAutomations } from '@/data/automations/testing';
import { buildProject, seedProjects } from '@/data/projects/testing';
import { LeftViewScope } from '@/hooks/use-left-view';
import { setActiveOrgSlug } from '@/lib/url-state';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

const actualLoaders = { ...(await import('@/data/automations/loaders')) };
mock.module('@/data/automations/loaders', () => ({
  ...actualLoaders,
  loadInbox: () => okAsync(null),
  loadAutomations: () => okAsync([]),
  loadAllAutomations: () => okAsync([]),
}));

// The model picker asks the runner for its dynamic catalogs; none here.
const actualRunnerHooks = { ...(await import('@/data/runner/hooks')) };
mock.module('@/data/runner/hooks', () => ({ ...actualRunnerHooks, useAcpModels: () => ({}) }));

const triageCalls: Array<[string, string]> = [];
const { automationsApi } = await import('@/lib/api/automations');
automationsApi.triageRun = (runId, status) => {
  triageCalls.push([runId, status]);
  return okAsync({ ok: true as const });
};

const { AutomationInboxView } = await import('@/components/AutomationInboxView');

const automation: Automation = {
  id: 'auto-1',
  projectId: 'proj-1',
  userId: 'user-1',
  name: 'Daily Issue Triage',
  prompt: 'Review all open issues',
  schedule: '0 9 * * *',
  provider: 'claude',
  model: 'sonnet',
  mode: 'local',
  permissionMode: 'autoEdit',
  maxRunHistory: 10,
  enabled: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderAt(path: string, scope: 'inbox' | null = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LeftViewScope value={scope}>
                <AutomationInboxView />
              </LeftViewScope>
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AutomationInboxView — Manage Automations', () => {
  beforeEach(() => {
    // buildPath() prefixes the active org slug, which other suites leave set.
    setActiveOrgSlug(null);
    seedProjects([
      buildProject({ id: 'proj-1', name: 'funny' }),
      buildProject({ id: 'proj-2', name: 'aries' }),
      buildProject({ id: 'proj-3', name: 'empty' }),
    ]);
    seedAutomations({
      automations: [
        automation,
        { ...automation, id: 'auto-2', projectId: 'proj-2', name: 'Weekly Report' },
      ],
    });
    useProjectStore.setState({ selectedProjectId: 'proj-1' });
  });

  test('shows the automation list in place instead of navigating to settings', () => {
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <AutomationInboxView />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByText('Daily Issue Triage')).toBeNull();
    fireEvent.click(screen.getByTestId('inbox-manage-automations'));

    expect(screen.getByTestId('location').textContent).toBe('/inbox/automations');
    // Opens on "All projects": every project's automations, grouped by project.
    expect(screen.getByText('Daily Issue Triage')).toBeInTheDocument();
    expect(screen.getByText('Weekly Report')).toBeInTheDocument();
    expect(screen.getByTestId('automations-group-proj-1')).toBeInTheDocument();
    expect(screen.getByTestId('automations-group-proj-2')).toBeInTheDocument();
    expect(screen.queryByTestId('automations-group-proj-3')).toBeNull();

    fireEvent.click(screen.getByTestId('inbox-manage-back'));
    expect(screen.getByTestId('location').textContent).toBe('/inbox');
    expect(screen.getByTestId('inbox-manage-automations')).toBeInTheDocument();
    expect(screen.queryByText('Daily Issue Triage')).toBeNull();
  });

  test('opens the automation list straight from its URL, scoped to ?project=', () => {
    renderAt('/inbox/automations?project=proj-2');

    expect(screen.getByTestId('inbox-manage-project')).toHaveTextContent('aries');
    expect(screen.getByText('Weekly Report')).toBeInTheDocument();
    expect(screen.queryByText('Daily Issue Triage')).toBeNull();
  });

  test('an unknown ?project= shows every project', () => {
    renderAt('/inbox/automations?project=gone');

    expect(screen.getByText('Daily Issue Triage')).toBeInTheDocument();
    expect(screen.getByText('Weekly Report')).toBeInTheDocument();
  });

  test('editing an automation shows its project, so it can be moved', () => {
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <AutomationInboxView />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('inbox-manage-automations'));
    fireEvent.click(screen.getByTestId('automation-edit-auto-2'));

    expect(screen.getByTestId('automation-form-project')).toHaveTextContent('aries');
  });
});

function inboxItem(id: string, triageStatus: InboxItem['run']['triageStatus']): InboxItem {
  return {
    run: {
      id,
      automationId: 'auto-1',
      threadId: `thread-${id}`,
      status: 'completed',
      triageStatus,
      hasFindings: true,
      summary: `Summary of ${id}`,
      startedAt: '2026-11-26T10:00:00.000Z',
      completedAt: '2026-11-26T10:05:00.000Z',
    },
    automation,
    thread: { id: `thread-${id}`, projectId: 'proj-1', title: `Thread ${id}` },
  };
}

describe('AutomationInboxView — run list', () => {
  beforeEach(() => {
    setActiveOrgSlug(null);
    triageCalls.length = 0;
    seedProjects([buildProject({ id: 'proj-1', name: 'funny' })]);
    seedAutomations({
      automations: [automation],
      inbox: [
        inboxItem('run-1', 'pending'),
        inboxItem('run-2', 'pending'),
        inboxItem('run-3', 'pending'),
        inboxItem('run-4', 'dismissed'),
      ],
    });
  });

  test('lists the pending runs by default', () => {
    renderAt('/inbox');

    expect(screen.getByTestId('inbox-row-run-1')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-row-run-3')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-row-run-4')).toBeNull();
  });

  test('shows the project filter, the arrival time and no summary', () => {
    renderAt('/inbox');

    // One project with runs is enough for the filter to show.
    expect(screen.getByTestId('all-threads-project-filter')).toBeInTheDocument();
    expect(screen.queryByText('Summary of run-1')).toBeNull();
    const time = screen.getByTestId('inbox-row-time-run-1');
    const expected = new Date('2026-11-26T10:05:00.000Z').toLocaleString('en', {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(time.textContent).toContain(expected);
  });

  test('changes the status of every selected run at once', async () => {
    renderAt('/inbox');

    fireEvent.click(screen.getByTestId('inbox-row-check-run-1'));
    fireEvent.click(screen.getByTestId('inbox-row-check-run-2'));
    expect(screen.getByTestId('inbox-selected-count')).toHaveTextContent('2 selected');

    fireEvent.click(screen.getByTestId('inbox-bulk-review'));

    expect(triageCalls).toEqual([
      ['run-1', 'reviewed'],
      ['run-2', 'reviewed'],
    ]);
    // Reviewed runs leave the "pending" list; the third stays.
    await waitFor(() => expect(screen.queryByTestId('inbox-row-run-1')).toBeNull());
    expect(screen.queryByTestId('inbox-row-run-2')).toBeNull();
    expect(screen.getByTestId('inbox-row-run-3')).toBeInTheDocument();
  });

  test('opening a run navigates to its thread without closing the inbox first', () => {
    useUIStore.setState({ automationInboxOpen: true });
    renderAt('/inbox');

    fireEvent.click(screen.getByTestId('inbox-row-open-run-1'));

    expect(screen.getByTestId('location').textContent).toBe(
      '/projects/proj-1/threads/thread-run-1',
    );
    // The route sync closes it with the URL change; closing it here showed the
    // new-thread input while the URL was still /inbox.
    expect(useUIStore.getState().automationInboxOpen).toBe(true);
  });

  test('a run opened from the inbox as a left view keeps the inbox beside the thread', () => {
    renderAt('/inbox', 'inbox');
    fireEvent.click(screen.getByTestId('inbox-row-open-run-1'));
    expect(screen.getByTestId('location').textContent).toBe(
      '/projects/proj-1/threads/thread-run-1?left=inbox',
    );
  });

  test('highlights the run whose thread is open beside the inbox', () => {
    renderAt('/projects/proj-1/threads/thread-run-1');
    expect(screen.getByTestId('inbox-row-run-1')).toHaveAttribute('aria-current', 'true');
  });

  test('lays the toolbar out as GitHub: select all, the status, the filters, then the search', () => {
    renderAt('/inbox');

    const ids = [
      'inbox-select-all',
      'inbox-status-trigger',
      'all-threads-project-filter',
      'inbox-findings-filter',
      'inbox-search-bar',
    ];
    const order = ids.map((id) => screen.getByTestId(id));
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // One status at a time, pending by default.
    expect(screen.getByTestId('inbox-status-trigger')).toHaveTextContent('Pending');

    // No run count.
    expect(screen.queryByText('3 runs')).toBeNull();

    // Once runs are selected, the bulk actions take the filters' place.
    fireEvent.click(screen.getByTestId('inbox-row-check-run-1'));
    expect(screen.queryByTestId('inbox-status-trigger')).toBeNull();
    expect(screen.getByTestId('inbox-bulk-review')).toBeInTheDocument();
  });

  test('with no run in the status, the status selector stays to change it', () => {
    seedAutomations({ automations: [automation], inbox: [inboxItem('run-9', 'reviewed')] });
    renderAt('/inbox');

    expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-status-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-select-all')).toBeNull();
  });

  test('select all takes every listed run, shift-click a range', () => {
    renderAt('/inbox');

    fireEvent.click(screen.getByTestId('inbox-select-all'));
    expect(screen.getByTestId('inbox-selected-count')).toHaveTextContent('3 selected');
    fireEvent.click(screen.getByTestId('inbox-select-all'));
    expect(screen.queryByTestId('inbox-selected-count')).toBeNull();

    fireEvent.click(screen.getByTestId('inbox-row-check-run-1'));
    fireEvent.click(screen.getByTestId('inbox-row-check-run-3'), { shiftKey: true });
    expect(screen.getByTestId('inbox-selected-count')).toHaveTextContent('3 selected');
  });
});
