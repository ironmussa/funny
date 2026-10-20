import { screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { IssuesTab } from '@/components/IssuesTab';
import { useProjectStore } from '@/stores/project-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const apiMock = vi.hoisted(() => ({ projectGetRemoteUrl: vi.fn(), githubIssuesEnriched: vi.fn() }));
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
});
