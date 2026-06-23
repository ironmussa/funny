import type { Project, Thread } from '@funny/shared';
import { DEFAULT_MODEL } from '@funny/shared/models';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ProjectItem } from '@/components/sidebar/ProjectItem';
import { resetExternalClaudeSessionsForTests } from '@/hooks/use-external-claude-sessions';
import { api } from '@/lib/api';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: vi.fn(() => () => {}),
  dropTargetForElements: vi.fn(() => () => {}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/hooks/use-minute-tick', () => ({
  useMinuteTick: () => {},
}));

vi.mock('@/lib/api', () => ({
  api: {
    listExternalClaudeSessions: vi.fn(),
    importExternalClaudeSession: vi.fn(),
    dismissExternalClaudeSession: vi.fn(),
    openDirectory: vi.fn(),
  },
}));

const project: Project = {
  id: 'project-1',
  name: 'funny',
  path: '/work/funny',
  color: '#7CB9E8',
  userId: 'user-1',
  sortOrder: 0,
  createdAt: '2026-06-23T11:00:00.000Z',
};

const thread: Thread = {
  id: 'thread-normal',
  projectId: 'project-1',
  userId: 'user-1',
  title: 'normal thread',
  mode: 'local',
  status: 'completed',
  stage: 'in_progress',
  provider: 'claude',
  permissionMode: 'autoEdit',
  model: DEFAULT_MODEL,
  cost: 0,
  source: 'web',
  runtime: 'local',
  createdAt: '2026-06-23T12:00:00.000Z',
  updatedAt: '2026-06-23T12:00:00.000Z',
};

const externalThread: Thread = {
  id: 'thread-external',
  projectId: 'project-1',
  userId: 'user-1',
  title: 'como estas?',
  mode: 'local',
  status: 'completed',
  stage: 'in_progress',
  provider: 'claude',
  permissionMode: 'autoEdit',
  model: DEFAULT_MODEL,
  cost: 0,
  source: 'ingest',
  runtime: 'local',
  createdBy: 'external',
  sessionId: 'session-1',
  externalRequestId: 'claude:session-1',
  branch: 'master',
  baseBranch: 'master',
  initialPrompt: 'como estas?',
  createdAt: '2026-06-23T12:05:00.000Z',
  updatedAt: '2026-06-23T12:06:00.000Z',
  completedAt: '2026-06-23T12:06:00.000Z',
};

describe('ProjectItem external Claude sessions', () => {
  beforeEach(() => {
    resetExternalClaudeSessionsForTests();
    vi.clearAllMocks();
    vi.mocked(api.listExternalClaudeSessions).mockReturnValue(okAsync({ sessions: [] }));
    vi.mocked(api.importExternalClaudeSession).mockReturnValue(
      okAsync({
        imported: true,
        thread: { id: 'thread-imported', projectId: 'project-1' },
      }),
    );
    vi.mocked(api.dismissExternalClaudeSession).mockReturnValue(okAsync({ ok: true }));
    vi.mocked(api.openDirectory).mockReturnValue(okAsync({ ok: true }));
  });

  test('renders synced external Claude shells as normal threads and hydrates on click', async () => {
    const onSelectThread = vi.fn();
    const onRenameThread = vi.fn();
    const onArchiveThread = vi.fn();
    const onPinThread = vi.fn();
    const onDeleteThread = vi.fn();
    const { container } = renderWithProviders(
      <ProjectItem
        project={project}
        threads={[thread, externalThread]}
        threadsLoaded
        isExpanded
        isSelected={false}
        onToggle={vi.fn()}
        onSelectProject={vi.fn()}
        onNewThread={vi.fn()}
        onRenameProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onSelectThread={onSelectThread}
        onRenameThread={onRenameThread}
        onArchiveThread={onArchiveThread}
        onPinThread={onPinThread}
        onDeleteThread={onDeleteThread}
        onShowAllThreads={vi.fn()}
        onShowIssues={vi.fn()}
      />,
    );

    const externalRow = await screen.findByTestId('thread-item-thread-external');
    // ProjectItem no longer triggers the external-sessions fetch itself — that
    // is a single global poll owned by SidebarProjectsSection.
    expect(api.listExternalClaudeSessions).not.toHaveBeenCalled();
    expect(screen.getByTestId('thread-item-thread-normal')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-external-claude-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('external-claude-import-session-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('thread-item-more-thread-external')).toBeInTheDocument();

    const rows = Array.from(
      container.querySelectorAll(
        '[data-testid^="thread-item-"]:not([data-testid^="thread-item-more-"])',
      ),
    );
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'thread-item-thread-external',
      'thread-item-thread-normal',
    ]);

    fireEvent.click(externalRow);

    await waitFor(() => {
      expect(api.importExternalClaudeSession).toHaveBeenCalledWith('session-1', {
        projectId: 'project-1',
      });
    });
    await waitFor(() => {
      expect(onSelectThread).toHaveBeenCalledWith('project-1', 'thread-external');
    });
  });

  test('dismisses an external Claude shell before normal delete flow', async () => {
    const onDeleteThread = vi.fn();
    renderWithProviders(
      <ProjectItem
        project={project}
        threads={[externalThread]}
        threadsLoaded
        isExpanded
        isSelected={false}
        onToggle={vi.fn()}
        onSelectProject={vi.fn()}
        onNewThread={vi.fn()}
        onRenameProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onSelectThread={vi.fn()}
        onRenameThread={vi.fn()}
        onArchiveThread={vi.fn()}
        onPinThread={vi.fn()}
        onDeleteThread={onDeleteThread}
        onShowAllThreads={vi.fn()}
        onShowIssues={vi.fn()}
      />,
    );

    fireEvent.pointerDown(await screen.findByTestId('thread-item-more-thread-external'));
    fireEvent.click(await screen.findByTestId('thread-delete-thread-external'));

    await waitFor(() => {
      expect(api.dismissExternalClaudeSession).toHaveBeenCalledWith('session-1');
    });
    expect(onDeleteThread).toHaveBeenCalledWith('project-1', 'thread-external', 'como estas?');
  });
});
