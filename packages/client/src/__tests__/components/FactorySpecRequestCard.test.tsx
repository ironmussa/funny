/**
 * An agent's request to approve a run's spec draft (openspec
 * factory-spec-stage), as its thread shows it: the draft comes from the run,
 * approving names the revision the agent asked about, a newer draft expires
 * the request, and only a member with `steer` gets the buttons.
 */
import { beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import type { FactoryApprovalRequest, FactorySpec } from '@funny/shared/contracts/factory';
import { fireEvent, render, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { TooltipProvider } from '@/components/ui/tooltip';
import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryRun } from '@/lib/api/factory';

interface CardMocks {
  runs: FactoryRun[] | undefined;
  requests: FactoryApprovalRequest[];
  canSteer: boolean;
  approveSpec: Mock<(...args: any[]) => any>;
  decline: Mock<(...args: any[]) => any>;
}

const mocks = ((): CardMocks => ({
  runs: [],
  requests: [],
  canSteer: true,
  approveSpec: vi.fn(),
  decline: vi.fn(),
}))();

mock.module('@/data/factory/hooks', () => ({
  useFactoryRuns: () => mocks.runs,
  useFactoryApprovalRequests: () => mocks.requests,
}));
mock.module('@/data/projects/hooks', () => ({ useCanSteerProject: () => mocks.canSteer }));
mock.module('@/data/factory/actions', () => ({
  controlFactoryRun: () => okAsync(null),
  approveFactoryMerge: () => okAsync(null),
  approveFactorySpec: (...args: unknown[]) => mocks.approveSpec(...args),
  reopenFactorySpec: () => okAsync(null),
  setFactoryRunLintCleanup: () => ({ orTee: () => undefined }),
  markFactoryRunDone: () => ({ orTee: () => undefined }),
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

const DRAFT: FactorySpec = {
  summary: 'Add a logout button to the user menu',
  decisions: [{ question: 'Where does Log out live?', answer: 'In the user menu' }],
  behavior: [],
  approach: [],
  outOfScope: [],
  validation: ['Log out ends the session'],
  contract: { acceptanceCriteria: ['A user can log out'], likelyPaths: [], riskHints: [] },
};

const runWithDraft = (revision: number, state: FactoryRun['state'] = 'needs_spec'): FactoryRun =>
  buildFactoryRun({
    id: 'r1',
    issueNumber: 451,
    state,
    completedAt: null,
    spec: { threadId: 't-spec', revision, latest: { status: 'draft', spec: DRAFT } },
  });

const specRequest = (over: Partial<FactoryApprovalRequest> = {}): FactoryApprovalRequest => ({
  id: 'q1',
  runId: 'r1',
  projectId: 'p1',
  threadId: 't1',
  kind: 'spec',
  specRevision: 2,
  sha: '',
  state: 'pending',
  createdAt: '2026-11-26T23:00:00.000Z',
  resolvedAt: null,
  ...over,
});

const renderCard = () =>
  render(<FactoryApprovalRequestCard projectId="p1" requestId="q1" />, {
    wrapper: TooltipProvider,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runs = [runWithDraft(2)];
  mocks.requests = [specRequest()];
  mocks.canSteer = true;
  mocks.approveSpec.mockImplementation(() => okAsync(runWithDraft(2, 'requested')));
  mocks.decline.mockImplementation(() => okAsync(specRequest({ state: 'declined' })));
});

describe('a spec approval request in the thread', () => {
  test('shows the run’s draft, not a commit, and approves the revision asked about', () => {
    renderCard();
    const card = screen.getByTestId('factory-spec-request-card-q1');
    expect(card).toHaveAttribute('data-outcome', 'pending');
    expect(card).toHaveTextContent('Spec of #451 waits for your approval');
    expect(screen.getByTestId('factory-spec-decisions')).toHaveTextContent(
      'Where does Log out live? — In the user menu',
    );
    expect(screen.queryByTestId('factory-approval-sha-q1')).toBeNull();

    fireEvent.click(screen.getByTestId('factory-spec-request-approve-q1'));
    expect(mocks.approveSpec).toHaveBeenCalledWith('p1', 'r1', 2);
  });

  test('declining closes the request and approves nothing', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('factory-spec-request-decline-q1'));
    expect(mocks.decline).toHaveBeenCalledWith('p1', 'q1');
    expect(mocks.approveSpec).not.toHaveBeenCalled();
  });

  test('a newer draft expires the request: no buttons, and it says why', () => {
    mocks.runs = [runWithDraft(3)];
    renderCard();
    expect(screen.getByTestId('factory-spec-request-card-q1')).toHaveAttribute(
      'data-outcome',
      'expired',
    );
    expect(screen.getByTestId('factory-spec-request-stale-q1')).toBeInTheDocument();
    expect(screen.queryByTestId('factory-spec-request-approve-q1')).toBeNull();
  });

  test('a member without steer sees the draft but no buttons', () => {
    mocks.canSteer = false;
    renderCard();
    expect(screen.getByTestId('factory-spec-decisions')).toBeInTheDocument();
    expect(screen.queryByTestId('factory-spec-request-approve-q1')).toBeNull();
  });

  test('an approved request stays and says where the run is now', () => {
    mocks.requests = [specRequest({ state: 'approved' })];
    mocks.runs = [runWithDraft(2, 'requested')];
    renderCard();
    expect(screen.getByTestId('factory-spec-request-card-q1')).toHaveTextContent(
      'You approved the spec of #451',
    );
    expect(screen.getByTestId('factory-spec-request-run-now-q1')).toBeInTheDocument();
  });
});
