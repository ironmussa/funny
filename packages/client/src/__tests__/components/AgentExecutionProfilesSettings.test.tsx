import type { AgentExecutionProfileResponse, Project } from '@funny/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { mockT } from '../helpers/mock-i18n';

const mockListAgentExecutionProfiles = vi.hoisted(() => vi.fn());
const mockCreateAgentExecutionProfile = vi.hoisted(() => vi.fn());
const mockUpdateAgentExecutionProfile = vi.hoisted(() => vi.fn());
const mockDeleteAgentExecutionProfile = vi.hoisted(() => vi.fn());
const mockGetProjectAgentProfileBinding = vi.hoisted(() => vi.fn());
const mockUpdateProjectAgentProfileBinding = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    listAgentExecutionProfiles: mockListAgentExecutionProfiles,
    createAgentExecutionProfile: mockCreateAgentExecutionProfile,
    updateAgentExecutionProfile: mockUpdateAgentExecutionProfile,
    deleteAgentExecutionProfile: mockDeleteAgentExecutionProfile,
    getProjectAgentProfileBinding: mockGetProjectAgentProfileBinding,
    updateProjectAgentProfileBinding: mockUpdateProjectAgentProfileBinding,
  },
}));

import { AgentExecutionProfilesSettings } from '@/components/settings/AgentExecutionProfilesSettings';
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
    useProjectStore.setState({
      projects: [{ id: 'project-1', name: 'Project One' } as Project],
      selectedProjectId: 'project-1',
    });
  });

  test('loads profiles and the selected project binding', async () => {
    mockListAgentExecutionProfiles.mockReturnValue(okAsync({ profiles: [workProfile] }));
    mockGetProjectAgentProfileBinding.mockReturnValue(
      okAsync({ projectId: 'project-1', profile: workProfile }),
    );

    render(<AgentExecutionProfilesSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-profile-profile-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('agent-profile-profile-1-name')).toHaveValue('Work Claude');
    expect(screen.getByTestId('agent-profile-profile-1-config-dir')).toHaveValue(
      '/home/user/.claude-work',
    );
    expect(mockGetProjectAgentProfileBinding).toHaveBeenCalledWith('project-1');
  });

  test('creates a Claude profile', async () => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
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
    fireEvent.click(screen.getByTestId('agent-profile-create'));

    await waitFor(() => {
      expect(mockCreateAgentExecutionProfile).toHaveBeenCalledWith({
        provider: 'claude',
        name: 'Work Claude',
        config: { claude: { configDir: '/home/user/.claude-work' } },
      });
    });
    expect(await screen.findByTestId('agent-profile-profile-1')).toBeInTheDocument();
  });
});
