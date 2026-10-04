import type { Project } from '@funny/shared';
import type { ProjectRunnerSettingsResponse, RunnerInfo } from '@funny/shared/runner-protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { mockT } from '../helpers/mock-i18n';

const mockGet = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockGrant = vi.hoisted(() => vi.fn());
const mockRevoke = vi.hoisted(() => vi.fn());
const mockSetGeneral = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/api', () => ({
  api: {
    getProjectRunnerSettings: mockGet,
    updateProjectRunnerSettings: mockUpdate,
    grantProjectRunner: mockGrant,
    revokeProjectRunner: mockRevoke,
    setGeneralRunner: mockSetGeneral,
  },
}));

import { ProjectRunnerSettings } from '@/components/settings/ProjectRunnerSettings';
import { useProjectStore } from '@/stores/project-store';

function runner(runnerId: string, role: 'general' | 'dedicated', online = true): RunnerInfo {
  return {
    runnerId,
    name: runnerId,
    hostname: runnerId,
    os: 'linux',
    status: online ? 'online' : 'offline',
    role,
    activeThreadCount: 0,
    assignedProjectIds: [],
    registeredAt: '',
    lastHeartbeatAt: '',
  };
}

function settings(overrides: Partial<ProjectRunnerSettingsResponse> = {}) {
  return {
    projectId: 'p1',
    dedicatedRunnerId: null,
    grantedRunnerIds: [],
    hasGithubToken: false,
    generalRunnerId: null,
    runners: [runner('laptop', 'general'), runner('rx', 'dedicated')],
    ...overrides,
  } satisfies ProjectRunnerSettingsResponse;
}

describe('ProjectRunnerSettings', () => {
  beforeEach(() => {
    for (const m of [mockGet, mockUpdate, mockGrant, mockRevoke, mockSetGeneral]) m.mockReset();
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'P1' } as Project],
      selectedProjectId: 'p1',
    });
  });

  test('project on the general runner: no grants list, no warnings', async () => {
    mockGet.mockReturnValue(okAsync(settings()));
    render(<ProjectRunnerSettings />);
    await waitFor(() =>
      expect(screen.getByTestId('project-runner-dedicated-select')).toBeInTheDocument(),
    );
    expect(mockGet).toHaveBeenCalledWith('p1');
    expect(screen.queryByTestId('project-runner-grant-laptop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-runner-offline-alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-runner-personal-token-warning')).not.toBeInTheDocument();
  });

  test('pinned to an offline dedicated runner using the personal token', async () => {
    mockGet.mockReturnValue(
      okAsync(
        settings({
          dedicatedRunnerId: 'rx',
          runners: [runner('laptop', 'general'), runner('rx', 'dedicated', false)],
        }),
      ),
    );
    render(<ProjectRunnerSettings />);
    await waitFor(() =>
      expect(screen.getByTestId('project-runner-offline-alert')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('project-runner-personal-token-warning')).toBeInTheDocument();
    expect(screen.getByTestId('project-runner-grant-laptop')).toBeInTheDocument();
  });

  test('granting another runner calls the API', async () => {
    mockGet.mockReturnValue(okAsync(settings({ dedicatedRunnerId: 'rx' })));
    mockGrant.mockReturnValue(
      okAsync(settings({ dedicatedRunnerId: 'rx', grantedRunnerIds: ['laptop'] })),
    );
    render(<ProjectRunnerSettings />);
    const toggle = await screen.findByTestId('project-runner-grant-laptop');
    fireEvent.click(toggle);
    await waitFor(() => expect(mockGrant).toHaveBeenCalledWith('p1', 'laptop'));
  });

  test('saving a project GitHub token sends it once and clears the input', async () => {
    mockGet.mockReturnValue(okAsync(settings()));
    mockUpdate.mockReturnValue(okAsync(settings({ hasGithubToken: true })));
    render(<ProjectRunnerSettings />);
    const input = await screen.findByTestId('project-runner-github-token');
    fireEvent.change(input, { target: { value: 'ghp_x' } });
    fireEvent.click(screen.getByTestId('project-runner-github-token-save'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('p1', { githubToken: 'ghp_x' }));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    expect(screen.getByTestId('project-runner-github-token-clear')).toBeInTheDocument();
  });
});
