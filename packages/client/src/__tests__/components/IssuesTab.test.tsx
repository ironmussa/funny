import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { IssuesTab } from '@/components/IssuesTab';
import { useProjectStore } from '@/stores/project-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const apiMock = vi.hoisted(() => ({
  projectGetRemoteUrl: vi.fn(),
  githubIssuesEnriched: vi.fn(),
  githubIssueComments: vi.fn(),
}));
const logError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/client-logger', () => ({
  createClientLogger: () => ({ error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({ api: apiMock }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('IssuesTab remote checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ selectedProjectId: 'project-1' });
  });

  test('does not log a request cancelled on unmount', async () => {
    apiMock.projectGetRemoteUrl.mockReturnValue(
      okAsync({ remoteUrl: 'https://github.com/acme/repo' }),
    );
    let reject!: (error: Error) => void;
    const pending = ResultAsync.fromPromise(
      new Promise<never>((_resolve, fail) => {
        reject = fail;
      }),
      () => ({ message: 'Request aborted' }),
    );
    apiMock.githubIssuesEnriched.mockReturnValue(pending);
    const view = renderWithProviders(<IssuesTab visible />);
    await waitFor(() => expect(apiMock.githubIssuesEnriched).toHaveBeenCalled());
    const signal = apiMock.githubIssuesEnriched.mock.calls[0][2] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      reject(new Error('Request aborted'));
      await pending;
    });
    expect(logError).not.toHaveBeenCalled();
  });

  test('still logs a real request failure', async () => {
    apiMock.projectGetRemoteUrl.mockReturnValue(
      okAsync({ remoteUrl: 'https://github.com/acme/repo' }),
    );
    apiMock.githubIssuesEnriched.mockReturnValue(errAsync({ message: 'Runner unavailable' }));
    renderWithProviders(<IssuesTab visible />);
    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        'failed to load issues',
        expect.objectContaining({ error: 'Runner unavailable' }),
      ),
    );
  });

  test('skips issue queries for a local-only repository', async () => {
    apiMock.projectGetRemoteUrl.mockReturnValue(okAsync({ remoteUrl: null }));
    renderWithProviders(<IssuesTab visible />);
    await screen.findByTestId('github-remote-unavailable');
    expect(apiMock.githubIssuesEnriched).not.toHaveBeenCalled();
  });

  test('renders issues for a configured repository and cancels on unmount', async () => {
    apiMock.projectGetRemoteUrl.mockReturnValue(
      okAsync({ remoteUrl: 'https://github.com/acme/repo' }),
    );
    apiMock.githubIssuesEnriched.mockReturnValue(
      okAsync({
        owner: 'acme',
        repo: 'repo',
        hasMore: false,
        issues: [
          {
            number: 1,
            title: 'Fix connection',
            body: 'Details',
            state: 'open',
            html_url: 'https://github.com/acme/repo/issues/1',
            labels: [],
            comments: 0,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    const view = renderWithProviders(<IssuesTab visible />);
    expect(await screen.findByTestId('issue-item-1')).toHaveTextContent('Fix connection');
    await waitFor(() => expect(apiMock.githubIssuesEnriched).toHaveBeenCalled());
    const signal = apiMock.githubIssuesEnriched.mock.calls[0][2] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  test('clicking an issue title opens the detail dialog with its comments', async () => {
    apiMock.projectGetRemoteUrl.mockReturnValue(
      okAsync({ remoteUrl: 'https://github.com/acme/repo' }),
    );
    apiMock.githubIssuesEnriched.mockReturnValue(
      okAsync({
        owner: 'acme',
        repo: 'repo',
        hasMore: false,
        issues: [
          {
            number: 7,
            title: 'Crash on start',
            body: 'Stack trace here',
            state: 'open',
            html_url: 'https://github.com/acme/repo/issues/7',
            labels: [],
            comments: 1,
            created_at: '2026-01-01T00:00:00Z',
            user: { login: 'octo', avatar_url: '' },
            linkedBranch: null,
            linkedPR: null,
            suggestedBranchName: 'issue-7-crash-on-start',
          },
        ],
      }),
    );
    apiMock.githubIssueComments.mockReturnValue(
      okAsync({
        comments: [
          {
            id: 99,
            author: 'reviewer',
            author_avatar_url: '',
            author_association: 'MEMBER',
            body: 'I can reproduce it',
            created_at: '2026-01-02T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
            html_url: '',
            reactions: { total: 0 },
          },
        ],
      }),
    );
    renderWithProviders(<IssuesTab visible />);
    fireEvent.click(await screen.findByTestId('issue-title-7'));

    expect(await screen.findByTestId('issue-detail-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('issue-detail-title')).toHaveTextContent('Crash on start');
    expect(await screen.findByTestId('issue-detail-comment-99')).toBeInTheDocument();
    expect(apiMock.githubIssueComments).toHaveBeenCalledWith('project-1', 7);
  });
});
