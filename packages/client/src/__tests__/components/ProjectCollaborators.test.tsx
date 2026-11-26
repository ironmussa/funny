import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';

const mockListMembers = (() => vi.fn())();
const mockSearchUsers = (() => vi.fn())();

mock.module('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

mock.module('@/lib/api', () => ({
  api: {
    listProjectMembers: mockListMembers,
    searchUsers: mockSearchUsers,
    addProjectMember: vi.fn(),
    removeProjectMember: vi.fn(),
  },
}));

import { ProjectCollaborators } from '@/components/settings/ProjectCollaborators';
import { buildProject, withProjects } from '@/data/projects/testing';
import { useProjectStore } from '@/stores/project-store';

const alice = { id: 'u-alice', username: 'alice', name: 'Alice', email: 'alice@example.com' };

async function renderLoaded() {
  render(<ProjectCollaborators />);
  return screen.findByTestId('collaborators-search');
}

describe('ProjectCollaborators user search', () => {
  beforeEach(() => {
    mockListMembers.mockReset();
    mockSearchUsers.mockReset();
    mockListMembers.mockReturnValue(okAsync({ members: [] }));
    useProjectStore.setState(
      withProjects({
        projects: [buildProject({ id: 'p1', name: 'P1' })],
        selectedProjectId: 'p1',
      }),
    );
  });

  test('a query shows the spinner, then the users found', async () => {
    mockSearchUsers.mockReturnValue(okAsync([alice]));
    const input = await renderLoaded();

    fireEvent.change(input, { target: { value: 'al' } });
    expect(screen.getByText('Searching…')).toBeInTheDocument();

    expect(await screen.findByTestId('collaborators-result-u-alice')).toBeInTheDocument();
    expect(mockSearchUsers).toHaveBeenCalledWith('al');
  });

  test('a query too short to search drops the previous results', async () => {
    mockSearchUsers.mockReturnValue(okAsync([alice]));
    const input = await renderLoaded();

    fireEvent.change(input, { target: { value: 'al' } });
    await screen.findByTestId('collaborators-result-u-alice');

    fireEvent.change(input, { target: { value: 'a' } });
    expect(screen.queryByTestId('collaborators-result-u-alice')).not.toBeInTheDocument();
    expect(screen.getByText('No users found.')).toBeInTheDocument();

    // Searching again starts from the spinner, not the dropped results.
    fireEvent.change(input, { target: { value: 'ali' } });
    expect(screen.getByText('Searching…')).toBeInTheDocument();
    await waitFor(() => expect(mockSearchUsers).toHaveBeenCalledWith('ali'));
  });
});
