import { beforeEach, describe, expect, test, mock } from 'bun:test';

import type { Automation } from '@funny/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { seedAutomations } from '@/data/automations/testing';
import { buildProject, seedProjects } from '@/data/projects/testing';
import { useProjectStore } from '@/stores/project-store';

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
  return <div data-testid="location">{useLocation().pathname}</div>;
}

describe('AutomationInboxView — Manage Automations', () => {
  beforeEach(() => {
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

    expect(screen.getByTestId('location').textContent).toBe('/inbox');
    // Opens on "All projects": every project's automations, grouped by project.
    expect(screen.getByText('Daily Issue Triage')).toBeInTheDocument();
    expect(screen.getByText('Weekly Report')).toBeInTheDocument();
    expect(screen.getByTestId('automations-group-proj-1')).toBeInTheDocument();
    expect(screen.getByTestId('automations-group-proj-2')).toBeInTheDocument();
    expect(screen.queryByTestId('automations-group-proj-3')).toBeNull();

    fireEvent.click(screen.getByTestId('inbox-manage-back'));
    expect(screen.getByTestId('inbox-manage-automations')).toBeInTheDocument();
    expect(screen.queryByText('Daily Issue Triage')).toBeNull();
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
