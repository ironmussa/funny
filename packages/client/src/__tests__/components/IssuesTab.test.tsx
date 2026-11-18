import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { IssuesTab } from '@/components/IssuesTab';
import type { FactoryRun, FactorySettings } from '@/lib/api/factory';
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

// The caller's issue factory (change factory-manual-queue): none by default.
const factory = vi.hoisted(() => ({
  settings: null as FactorySettings | null,
  runs: [] as FactoryRun[],
  blockers: [] as Array<{ issue: number; blockers: Array<{ issue: number; inFactory: boolean }> }>,
  canSteer: true,
  send: vi.fn(),
  control: vi.fn(),
}));
vi.mock('@/data/factory/hooks', () => ({
  useFactorySettings: () => factory.settings,
  useFactoryRuns: () => factory.runs,
  useFactoryFlows: () => [
    { name: 'issue-to-merge', source: 'built-in' },
    { name: 'issue-to-pr', source: 'built-in' },
  ],
  useFactoryBlockers: () => factory.blockers,
}));
vi.mock('@/data/factory/actions', () => ({
  sendIssuesToFactory: (...args: unknown[]) => factory.send(...args),
  controlFactoryRun: (...args: unknown[]) => factory.control(...args),
}));
vi.mock('@/data/projects/hooks', async (original) => ({
  ...(await original<typeof import('@/data/projects/hooks')>()),
  useCanSteerProject: () => factory.canSteer,
}));
/** `mockT`, plus `{{var}}` interpolation for a fallback given with its values. */
const t = (
  key: string,
  fallback?: string | Record<string, unknown>,
  vars?: Record<string, unknown>,
) =>
  typeof fallback === 'string' && vars
    ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars[name] ?? ''))
    : mockT(key, fallback);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'en' } }),
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

const issue = (number: number, state: 'open' | 'closed' = 'open') => ({
  number,
  title: `Issue ${number}`,
  body: '',
  state,
  html_url: `https://github.com/acme/repo/issues/${number}`,
  labels: [],
  comments: 0,
  created_at: '2026-01-01T00:00:00Z',
});

const factorySettings = (over: Partial<FactorySettings> = {}): FactorySettings => ({
  projectId: 'project-1',
  enabled: true,
  mode: 'manual',
  label: 'ready-for-agent',
  flowName: 'issue-to-merge',
  maxConcurrent: 2,
  blockedReason: null,
  updatedAt: '2026-11-16T00:00:00.000Z',
  ...over,
});

const factoryRun = (over: Partial<FactoryRun>): FactoryRun => ({
  id: 'r1',
  factoryId: 'f1',
  issueNumber: 1,
  prUrl: null,
  state: 'working',
  currentStep: 'implement',
  threadIds: ['t1'],
  startedAt: '2026-11-16T00:00:00.000Z',
  completedAt: null,
  source: 'manual',
  flowName: 'issue-to-merge',
  queueOrder: null,
  waitReason: null,
  ...over,
});

describe('IssuesTab and the issue factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ selectedProjectId: 'project-1' });
    factory.settings = factorySettings();
    factory.runs = [];
    factory.blockers = [];
    factory.canSteer = true;
    factory.send.mockImplementation((_p: string, issues: number[]) =>
      okAsync({ accepted: issues, refused: [] }),
    );
    factory.control.mockImplementation(() => okAsync({}));
    apiMock.projectGetRemoteUrl.mockReturnValue(
      okAsync({ remoteUrl: 'https://github.com/acme/repo' }),
    );
  });

  const showIssues = (issues: ReturnType<typeof issue>[]) => {
    apiMock.githubIssuesEnriched.mockReturnValue(
      okAsync({ owner: 'acme', repo: 'repo', hasMore: false, issues }),
    );
    renderWithProviders(<IssuesTab visible />);
  };

  test('without a factory, or without steer, issues have no checkbox', async () => {
    factory.settings = null;
    showIssues([issue(1)]);
    await screen.findByTestId('issue-item-1');
    expect(screen.queryByTestId('issue-select-1')).toBeNull();
  });

  test('selected issues are sent with the chosen flow', async () => {
    showIssues([issue(1), issue(2), issue(3, 'closed')]);
    fireEvent.click(await screen.findByTestId('issue-select-2'));
    fireEvent.click(screen.getByTestId('issue-select-1'));
    expect(screen.queryByTestId('issue-select-3')).toBeNull();

    expect(screen.getByTestId('issues-factory-flow')).toHaveTextContent('issue-to-merge');
    fireEvent.click(screen.getByTestId('issues-factory-send'));

    expect(factory.send).toHaveBeenCalledWith('project-1', [2, 1], 'issue-to-merge');
    await waitFor(() => expect(screen.queryByTestId('issues-factory-bar')).toBeNull());
  });

  test('an issue in the factory shows its state instead of a checkbox', async () => {
    factory.runs = [
      factoryRun({ id: 'a', issueNumber: 1, state: 'waiting_ci' }),
      factoryRun({ id: 'b', issueNumber: 2, state: 'requested', threadIds: [], queueOrder: 4 }),
    ];
    showIssues([issue(1), issue(2)]);

    expect(await screen.findByTestId('issue-factory-status-1')).toHaveTextContent('Waiting for CI');
    expect(screen.queryByTestId('issue-select-1')).toBeNull();
    expect(screen.getByTestId('issue-factory-thread-1')).toHaveAttribute(
      'href',
      expect.stringContaining('t1'),
    );
    expect(screen.getByTestId('issue-factory-status-2')).toHaveTextContent('In queue · #1');

    fireEvent.click(screen.getByTestId('issue-factory-cancel-2'));
    expect(factory.control).toHaveBeenCalledWith('stop', 'project-1', 'b');
  });

  test('a paused factory disables the send and says why', async () => {
    factory.settings = factorySettings({ enabled: false });
    showIssues([issue(1)]);
    fireEvent.click(await screen.findByTestId('issue-select-1'));

    expect(screen.getByTestId('issues-factory-send')).toBeDisabled();
    expect(screen.getByTestId('issues-factory-disabled-reason')).toHaveTextContent('paused');
  });

  test('a factory that cannot work disables the send with its reason', async () => {
    factory.settings = factorySettings({ blockedReason: 'Waiting for your runner' });
    showIssues([issue(1)]);
    fireEvent.click(await screen.findByTestId('issue-select-1'));

    expect(screen.getByTestId('issues-factory-send')).toBeDisabled();
    expect(screen.getByTestId('issues-factory-disabled-reason')).toHaveTextContent(
      'Waiting for your runner',
    );
  });

  test('warns when a selected issue depends on one outside the factory, and still sends', async () => {
    factory.blockers = [{ issue: 2, blockers: [{ issue: 1, inFactory: false }] }];
    showIssues([issue(1), issue(2)]);
    fireEvent.click(await screen.findByTestId('issue-select-2'));

    expect(screen.getByTestId('issues-factory-warning')).toHaveTextContent('#1');
    expect(screen.getByTestId('issues-factory-send')).toBeEnabled();
  });
  test('a queued issue blocked by an issue outside the factory offers to send it', async () => {
    factory.runs = [
      factoryRun({
        id: 'b',
        issueNumber: 2,
        state: 'requested',
        threadIds: [],
        queueOrder: 1,
        flowName: 'issue-to-pr',
        waitReason: { kind: 'blocker-not-sent', blockers: [1] },
      }),
    ];
    showIssues([issue(1), issue(2)]);

    fireEvent.click(await screen.findByTestId('issue-factory-send-blockers-2'));

    expect(factory.send).toHaveBeenCalledWith('project-1', [1], 'issue-to-pr');
  });

  test('a send takes at most 50 issues: past that, a checkbox adds nothing', async () => {
    showIssues(Array.from({ length: 51 }, (_, i) => issue(i + 1)));
    await screen.findByTestId('issue-select-1');
    for (let n = 1; n <= 51; n++) fireEvent.click(screen.getByTestId(`issue-select-${n}`));

    expect(screen.getByTestId('issue-select-51')).not.toBeChecked();
    expect(screen.getByTestId('issues-factory-limit')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('issues-factory-send'));
    expect((factory.send.mock.calls[0][1] as number[]).length).toBe(50);
    // 51 rows and 51 clicks: slow when the whole suite runs in parallel.
  }, 20_000);

  test('the state icon turns into the checkbox, which stays shown once anything is selected', async () => {
    showIssues([issue(1), issue(2)]);
    const box = (n: number) => screen.getByTestId(`issue-select-${n}`).parentElement!;
    await screen.findByTestId('issue-select-toggle-1');

    // Hidden behind the state icon until hover or focus.
    expect(box(1)).toHaveClass('opacity-0');
    expect(box(2)).toHaveClass('opacity-0');

    fireEvent.click(screen.getByTestId('issue-select-1'));

    expect(box(1)).toHaveClass('opacity-100');
    expect(box(2)).toHaveClass('opacity-100');
  });
});
