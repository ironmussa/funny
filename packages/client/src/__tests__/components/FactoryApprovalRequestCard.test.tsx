/**
 * The card an agent's approval request shows in its thread (openspec
 * factory-agent-tools): the facts come from the run, approving is the board's
 * approval for the commit shown, declining closes the request, and a request
 * for a commit the run is no longer held on offers nothing.
 */
import { beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import type { FactoryApprovalRequest } from '@funny/shared/contracts/factory';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { TooltipProvider } from '@/components/ui/tooltip';
import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryRun } from '@/lib/api/factory';

interface CardMocks {
  runs: FactoryRun[] | undefined;
  requests: FactoryApprovalRequest[];
  settings: object | null;
  thread: { id: string; projectId: string; source: string; isScratch?: boolean } | undefined;
  canSteer: boolean;
  approve: Mock<(...args: any[]) => any>;
  decline: Mock<(...args: any[]) => any>;
  asked: Array<{ projectId: string | undefined; threadId: string | undefined; enabled: boolean }>;
}

const mocks = ((): CardMocks => ({
  runs: [],
  requests: [],
  settings: {},
  thread: undefined,
  canSteer: true,
  approve: vi.fn(),
  decline: vi.fn(),
  asked: [],
}))();

mock.module('@/data/factory/hooks', () => ({
  useFactoryRuns: () => mocks.runs,
  useFactorySettings: () => mocks.settings,
  usePendingApprovalRequestsOfThread: (
    projectId: string | undefined,
    threadId: string | undefined,
    enabled: boolean,
  ) => {
    mocks.asked.push({ projectId, threadId, enabled });
    return enabled ? mocks.requests.filter((request) => request.threadId === threadId) : [];
  },
}));
mock.module('@/lib/thread-selectors', () => ({ useThreadById: () => mocks.thread }));
mock.module('@/data/projects/hooks', () => ({ useCanSteerProject: () => mocks.canSteer }));
mock.module('@/data/factory/actions', () => ({
  controlFactoryRun: () => okAsync(null),
  approveFactoryMerge: (...args: unknown[]) => mocks.approve(...args),
  declineFactoryApprovalRequest: (...args: unknown[]) => mocks.decline(...args),
}));
mock.module('@/lib/toast-error', () => ({ toastError: vi.fn() }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      _key: string,
      fallback?: string | Record<string, unknown>,
      vars?: Record<string, unknown>,
    ) => {
      const text = typeof fallback === 'string' ? fallback : String(fallback?.defaultValue ?? _key);
      const values = typeof fallback === 'string' ? vars : fallback;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(values?.[name] ?? ''));
    },
  }),
}));

import { FactoryApprovalRequestCards } from '@/components/thread/FactoryApprovalRequestCard';

const A = 'c2b585c51b2e' + 'a'.repeat(28);
const B = 'd'.repeat(40);

const heldRun = (headSha = A): FactoryRun =>
  buildFactoryRun({
    id: 'r1',
    issueNumber: 451,
    state: 'waiting_human',
    currentStep: 'merge',
    failureReason: 'high risk',
    prUrl: 'https://github.com/o/r/pull/469',
    completedAt: null,
    risk: {
      headSha,
      level: 'high',
      reasons: ['touches a sensitive path: db/migrate.ts', '680 changed lines (more than 400)'],
      changedLines: 680,
      paths: ['db/migrate.ts'],
    },
  });

const request = (over: Partial<FactoryApprovalRequest> = {}): FactoryApprovalRequest => ({
  id: 'q1',
  runId: 'r1',
  projectId: 'p1',
  threadId: 't1',
  sha: A,
  state: 'pending',
  createdAt: '2026-11-24T23:00:00.000Z',
  resolvedAt: null,
  ...over,
});

const renderCards = () =>
  render(<FactoryApprovalRequestCards threadId="t1" />, { wrapper: TooltipProvider });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runs = [heldRun()];
  mocks.requests = [request()];
  mocks.settings = {};
  mocks.thread = { id: 't1', projectId: 'p1', source: 'web' };
  mocks.canSteer = true;
  mocks.asked = [];
  mocks.approve.mockImplementation(() => okAsync(heldRun()));
  mocks.decline.mockImplementation(() => okAsync(request({ state: 'declined' })));
});

describe('FactoryApprovalRequestCards', () => {
  test('shows what the server knows about the run: issue, pull request, commit, size, reasons', () => {
    renderCards();
    const card = screen.getByTestId('factory-approval-card-q1');
    expect(card).toHaveTextContent('An agent asks you to approve this merge');
    expect(card).toHaveTextContent('Issue #451');
    expect(screen.getByTestId('factory-approval-pr-q1')).toHaveTextContent('#469');
    expect(screen.getByTestId('factory-approval-sha-q1')).toHaveTextContent('c2b585c');
    expect(card).toHaveTextContent('680 changed lines');
    const reasons = within(screen.getByTestId('factory-approval-reasons-q1')).getAllByRole(
      'listitem',
    );
    expect(reasons.map((item) => item.textContent)).toEqual([
      'touches a sensitive path: db/migrate.ts',
      '680 changed lines (more than 400)',
    ]);
    expect(card).toHaveTextContent('Nothing is approved until you approve it');
  });

  test('approving confirms first, then approves the commit the card shows', async () => {
    renderCards();
    fireEvent.click(screen.getByTestId('factory-approval-approve-q1'));
    expect(mocks.approve).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    expect(mocks.approve).toHaveBeenCalledWith('p1', 'r1', A);
    expect(mocks.decline).not.toHaveBeenCalled();
  });

  test('declining closes the request and approves nothing', () => {
    renderCards();
    fireEvent.click(screen.getByTestId('factory-approval-decline-q1'));
    expect(mocks.decline).toHaveBeenCalledWith('p1', 'q1');
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  test('a request for a commit the run is no longer held on offers no approval', () => {
    mocks.runs = [heldRun(B)];
    renderCards();
    expect(screen.getByTestId('factory-approval-stale-q1')).toBeInTheDocument();
    expect(screen.queryByTestId('factory-approval-approve-q1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('factory-approval-decline-q1')).not.toBeInTheDocument();
  });

  test('a run that left the hold offers no approval either', () => {
    mocks.runs = [{ ...heldRun(), state: 'working', failureReason: null }];
    renderCards();
    expect(screen.queryByTestId('factory-approval-approve-q1')).not.toBeInTheDocument();
  });

  test('a member who cannot steer sees the facts and no buttons', () => {
    mocks.canSteer = false;
    renderCards();
    expect(screen.getByTestId('factory-approval-card-q1')).toBeInTheDocument();
    expect(screen.queryByTestId('factory-approval-approve-q1')).not.toBeInTheDocument();
  });

  test("another thread's request is not shown here", () => {
    mocks.requests = [request({ threadId: 't-other' })];
    renderCards();
    expect(screen.queryByTestId('factory-approval-card-q1')).not.toBeInTheDocument();
  });

  test('nothing is asked without a factory, in a scratch thread or in a factory thread', () => {
    mocks.settings = null;
    const { unmount } = renderCards();
    expect(mocks.asked.every((call) => !call.enabled)).toBe(true);
    expect(screen.queryByTestId('factory-approval-card-q1')).not.toBeInTheDocument();
    unmount();

    mocks.settings = {};
    mocks.asked = [];
    for (const thread of [
      { id: 't1', projectId: 'p1', source: 'factory' },
      { id: 't1', projectId: '', source: 'web', isScratch: true },
    ]) {
      mocks.thread = thread;
      const view = renderCards();
      expect(screen.queryByTestId('factory-approval-card-q1')).not.toBeInTheDocument();
      view.unmount();
    }
    expect(mocks.asked).toEqual([]);
  });
});
