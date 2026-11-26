import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { AgentExecutionProfileResponse } from '@funny/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { mockT } from '../helpers/mock-i18n';

const mockListAgentExecutionProfiles = (() => vi.fn())();
const mockCreateAgentExecutionProfile = (() => vi.fn())();
const mockUpdateAgentExecutionProfile = (() => vi.fn())();
const mockDeleteAgentExecutionProfile = (() => vi.fn())();
const mockGetProjectAgentProfileBinding = (() => vi.fn())();
const mockUpdateProjectAgentProfileBinding = (() => vi.fn())();

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

mock.module('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

mock.module('@/lib/api', () => ({
  api: {
    listAgentExecutionProfiles: mockListAgentExecutionProfiles,
    createAgentExecutionProfile: mockCreateAgentExecutionProfile,
    updateAgentExecutionProfile: mockUpdateAgentExecutionProfile,
    deleteAgentExecutionProfile: mockDeleteAgentExecutionProfile,
    getProjectAgentProfileBinding: mockGetProjectAgentProfileBinding,
    updateProjectAgentProfileBinding: mockUpdateProjectAgentProfileBinding,
  },
}));

import {
  AgentExecutionProfilesSettings,
  ProjectAgentExecutionProfileSettings,
} from '@/components/settings/AgentExecutionProfilesSettings';
import { buildProject, withProjects } from '@/data/projects/testing';
import { useProjectStore } from '@/stores/project-store';

const workProfile: AgentExecutionProfileResponse = {
  id: 'profile-1',
  name: 'Work Claude',
  provider: 'claude',
  config: { claude: { configDir: '/home/user/.claude-work' } },
  createdAt: '2026-06-23T00:00:00.000Z',
  updatedAt: '2026-06-23T00:00:00.000Z',
};

function resetMocks() {
  mockListAgentExecutionProfiles.mockReset();
  mockCreateAgentExecutionProfile.mockReset();
  mockUpdateAgentExecutionProfile.mockReset();
  mockDeleteAgentExecutionProfile.mockReset();
  mockGetProjectAgentProfileBinding.mockReset();
  mockUpdateProjectAgentProfileBinding.mockReset();
}

describe('AgentExecutionProfilesSettings', () => {
  beforeEach(() => {
    resetMocks();
    useProjectStore.setState(
      withProjects({
        projects: [buildProject({ id: 'project-1', name: 'Project One' })],
        selectedProjectId: 'project-1',
      }),
    );
  });

  test('loads profiles and the selected project binding', async () => {
    mockListAgentExecutionProfiles.mockReturnValue(okAsync({ profiles: [workProfile] }));
    mockGetProjectAgentProfileBinding.mockReturnValue(
      okAsync({ projectId: 'project-1', profile: workProfile }),
    );

    render(<ProjectAgentExecutionProfileSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-profile-project-select')).toBeInTheDocument();
    });
    expect(mockGetProjectAgentProfileBinding).toHaveBeenCalledWith('project-1');
    expect(screen.queryByTestId('agent-profile-create-name')).not.toBeInTheDocument();
  });

  test('creates a Claude profile', async () => {
    useProjectStore.setState(withProjects({ projects: [], selectedProjectId: null }));
    mockListAgentExecutionProfiles.mockReturnValue(okAsync({ profiles: [] }));
    mockCreateAgentExecutionProfile.mockReturnValue(okAsync(workProfile));

    render(<AgentExecutionProfilesSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-profile-create-name')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('agent-profile-create-name'), {
      target: { value: 'Work Claude' },
    });
    fireEvent.change(screen.getByTestId('agent-profile-create-config-dir'), {
      target: { value: '/home/user/.claude-work' },
    });
    expect(
      screen.getByText('CLAUDE_CONFIG_DIR=/home/user/.claude-work claude auth login'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-profile-create'));

    await waitFor(() => {
      expect(mockCreateAgentExecutionProfile).toHaveBeenCalledWith({
        provider: 'claude',
        name: 'Work Claude',
        config: { claude: { configDir: '/home/user/.claude-work' } },
      });
    });
    expect(await screen.findByTestId('agent-profile-profile-1')).toBeInTheDocument();
    expect(mockGetProjectAgentProfileBinding).not.toHaveBeenCalled();
  });

  test('quotes Claude auth command directories with spaces', async () => {
    useProjectStore.setState(withProjects({ projects: [], selectedProjectId: null }));
    mockListAgentExecutionProfiles.mockReturnValue(okAsync({ profiles: [] }));

    render(<AgentExecutionProfilesSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-profile-create-config-dir')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('agent-profile-create-config-dir'), {
      target: { value: '/home/user/Claude Work' },
    });

    expect(
      screen.getByText("CLAUDE_CONFIG_DIR='/home/user/Claude Work' claude auth login"),
    ).toBeInTheDocument();
  });
});
