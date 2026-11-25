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
  canSteer: boolean;
  approve: Mock<(...args: any[]) => any>;
  decline: Mock<(...args: any[]) => any>;
}

const mocks = ((): CardMocks => ({
  runs: [],
  requests: [],
  canSteer: true,
  approve: vi.fn(),
  decline: vi.fn(),
}))();

mock.module('@/data/factory/hooks', () => ({
  useFactoryRuns: () => mocks.runs,
  useFactoryApprovalRequests: () => mocks.requests,
}));
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

import { FactoryApprovalRequestCard } from '@/components/thread/FactoryApprovalRequestCard';

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

const renderCard = () =>
  render(<FactoryApprovalRequestCard projectId="p1" requestId="q1" />, {
    wrapper: TooltipProvider,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runs = [heldRun()];
  mocks.requests = [request()];
  mocks.canSteer = true;
  mocks.approve.mockImplementation(() => okAsync(heldRun()));
  mocks.decline.mockImplementation(() => okAsync(request({ state: 'declined' })));
});

describe('FactoryApprovalRequestCard', () => {
  test('a pending request shows the run: title, pull request, commit, size, reasons', () => {
    renderCard();
    const card = screen.getByTestId('factory-approval-card-q1');
    expect(card).toHaveAttribute('data-outcome', 'pending');
    expect(card).toHaveTextContent('Approval needed to merge #451');
    expect(card).toHaveTextContent('High risk');
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
    renderCard();
    fireEvent.click(screen.getByTestId('factory-approval-approve-q1'));
    expect(mocks.approve).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    expect(mocks.approve).toHaveBeenCalledWith('p1', 'r1', A);
    expect(mocks.decline).not.toHaveBeenCalled();
  });

  test('declining closes the request and approves nothing', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('factory-approval-decline-q1'));
    expect(mocks.decline).toHaveBeenCalledWith('p1', 'q1');
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  test('an approved request stays, and says the run waits its turn', () => {
    // Run 08bc291e (#480, 2026-11-24): approved from the card, then queued
    // behind #450, which changes the same files. The card vanished and the
    // approval looked lost.
    mocks.requests = [request({ state: 'approved', resolvedAt: '2026-11-25T00:45:19.082Z' })];
    mocks.runs = [
      {
        ...heldRun(),
        state: 'requested',
        failureReason: null,
        waitReason: { kind: 'paths-overlap', blockers: [450] },
        mergeApproval: { sha: A, userId: 'alice', at: '2026-11-25T00:45:19.059Z' },
      },
    ];
    renderCard();
    const card = screen.getByTestId('factory-approval-card-q1');
    expect(card).toHaveAttribute('data-outcome', 'approved');
    expect(card).toHaveTextContent('You approved merging #451');
    expect(screen.getByTestId('factory-approval-sha-q1')).toHaveTextContent('c2b585c');
    const now = screen.getByTestId('factory-approval-run-now-q1');
    expect(now).toHaveTextContent('The run now:');
    expect(now).toHaveTextContent('#450');
    expect(screen.queryByTestId('factory-approval-approve-q1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('factory-approval-decline-q1')).not.toBeInTheDocument();
  });

  test('a declined request stays as a record with no buttons', () => {
    mocks.requests = [request({ state: 'declined' })];
    renderCard();
    const card = screen.getByTestId('factory-approval-card-q1');
    expect(card).toHaveAttribute('data-outcome', 'declined');
    expect(card).toHaveTextContent('You declined to approve #451');
    expect(card).toHaveTextContent('Nothing was approved');
    expect(screen.queryByTestId('factory-approval-approve-q1')).not.toBeInTheDocument();
  });

  test('a request for a commit the run is no longer held on offers no approval', () => {
    mocks.runs = [heldRun(B)];
    renderCard();
    expect(screen.getByTestId('factory-approval-card-q1')).toHaveAttribute(
      'data-outcome',
      'expired',
    );
    expect(screen.getByTestId('factory-approval-stale-q1')).toBeInTheDocument();
    expect(screen.queryByTestId('factory-approval-approve-q1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('factory-approval-decline-q1')).not.toBeInTheDocument();
  });

  test('a pending request whose run left the hold offers no approval either', () => {
    mocks.runs = [{ ...heldRun(), state: 'working', failureReason: null }];
    renderCard();
    expect(screen.queryByTestId('factory-approval-approve-q1')).not.toBeInTheDocument();
  });

  test('a member who cannot steer sees the facts and no buttons', () => {
    mocks.canSteer = false;
    renderCard();
    expect(screen.getByTestId('factory-approval-card-q1')).toBeInTheDocument();
    expect(screen.queryByTestId('factory-approval-approve-q1')).not.toBeInTheDocument();
  });

  test('an unknown request renders nothing', () => {
    mocks.requests = [];
    renderCard();
    expect(screen.queryByTestId('factory-approval-card-q1')).not.toBeInTheDocument();
  });
});
