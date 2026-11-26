/**
 * A factory run's detail panel (openspec factory-run-detail): its sections,
 * the thread links, and the `run` search parameter that opens it.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import type { FactoryIncident, FactoryReviewVerdict } from '@funny/shared/contracts/factory';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { TooltipProvider } from '@/components/ui/tooltip';
import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryQueueRun } from '@/lib/api/factory';

const mocks = ((): {
  queue: FactoryQueueRun[] | undefined;
  navigate: ReturnType<typeof vi.fn>;
  incidents: Record<string, FactoryIncident>;
  threads: Record<string, { id: string; title: string }>;
} => ({ queue: [], navigate: vi.fn(), incidents: {}, threads: {} }))();

mock.module('@/data/factory/hooks', () => ({
  useFactoryQueueRuns: () => mocks.queue,
  useFactorySettings: (projectId: string) =>
    mocks.incidents[projectId] ? { incident: mocks.incidents[projectId] } : null,
}));
mock.module('@/lib/thread-selectors', () => ({
  useThreadById: (id?: string) => (id ? mocks.threads[id] : undefined),
}));
mock.module('@/data/projects/hooks', () => ({
  useCanSteerProject: () => true,
  useProjects: () => [{ id: 'p1', name: 'funny' }],
}));
mock.module('@/data/factory/actions', () => ({
  approveFactoryMerge: () => okAsync(null),
  setFactoryRunLintCleanup: () => ({ orTee: () => undefined }),
  markFactoryRunDone: () => ({ orTee: () => undefined }),
  controlFactoryRun: () => okAsync(null),
  closeFactoryIncident: () => okAsync(null),
}));
mock.module('@/hooks/use-stable-navigate', () => ({ useStableNavigate: () => mocks.navigate }));
mock.module('@/hooks/use-minute-tick', () => ({ useMinuteTick: () => Date.now() }));
mock.module('@/lib/toast-error', () => ({ toastError: vi.fn() }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallback?: string | Record<string, unknown>,
      vars?: Record<string, unknown>,
    ) => {
      const text = typeof fallback === 'string' ? fallback : key;
      const values = typeof fallback === 'string' ? vars : fallback;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(values?.[name] ?? ''));
    },
  }),
}));

import { FactoryRunDetail } from '@/components/factory-board/run-detail/FactoryRunDetail';
import { FactoryQueueView } from '@/components/FactoryQueueView';

const queueRun = (over: Partial<FactoryQueueRun>): FactoryQueueRun => ({
  ...buildFactoryRun({ completedAt: null, admittedAt: new Date().toISOString() }),
  projectId: 'p1',
  ...over,
});

const verdict = (sha: string, pass: boolean, threadId: string): FactoryReviewVerdict => ({
  sha,
  verdict: pass ? 'pass' : 'fail',
  findings: pass ? [] : [{ severity: 'high', title: 'Null deref', path: 'src/a.ts', line: 12 }],
  reviewedAt: new Date().toISOString(),
  threadId,
});

const renderBody = (run: FactoryQueueRun) =>
  render(
    <TooltipProvider>
      <FactoryRunDetail run={run} projectName="funny" onClose={vi.fn()} />
    </TooltipProvider>,
  );

let location = '';
function LocationProbe() {
  const current = useLocation();
  useEffect(() => {
    location = `${current.pathname}${current.search}`;
  }, [current]);
  return null;
}
const renderView = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <TooltipProvider>
        <FactoryQueueView />
        <LocationProbe />
      </TooltipProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  mocks.queue = [];
  mocks.navigate = vi.fn();
  mocks.incidents = {};
  location = '';
});

describe('the panel content', () => {
  test('two review rounds, oldest first, each with its reviewer thread', () => {
    renderBody(
      queueRun({
        state: 'merging',
        reviews: [verdict('aaa1111ff', false, 't-rev-1'), verdict('bbb2222ff', true, 't-rev-2')],
      }),
    );
    const first = screen.getByTestId('factory-run-detail-review-0');
    expect(first).toHaveTextContent('aaa1111');
    expect(first).toHaveTextContent('Review failed');
    expect(first).toHaveTextContent('high');
    expect(first).toHaveTextContent('Null deref');
    expect(first).toHaveTextContent('src/a.ts:12');
    expect(screen.getByTestId('factory-run-detail-review-1')).toHaveTextContent('bbb2222');
    fireEvent.click(screen.getByTestId('factory-run-detail-review-thread-1'));
    expect(mocks.navigate).toHaveBeenCalledWith(expect.stringContaining('t-rev-2'));
  });

  test('triage asked on the issue: the questions and the triage thread', () => {
    renderBody(
      queueRun({
        state: 'needs_info',
        triage: {
          decision: 'needs_info',
          at: new Date().toISOString(),
          threadId: 't-tri',
          items: ['Which page?', 'Which browser?'],
        },
      }),
    );
    const items = screen.getByTestId('factory-run-detail-triage-items');
    expect(
      within(items)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Which page?', 'Which browser?']);
    expect(screen.getByTestId('factory-run-detail-triage-thread')).toBeTruthy();
    expect(screen.getByTestId('factory-run-detail-outcome')).toHaveTextContent(
      'Triage asked 2 questions',
    );
  });

  test('a run without an issue: its schedule, its inputs, and no triage, proof or reviews', () => {
    renderBody(
      queueRun({
        state: 'working',
        issueNumber: null,
        source: 'schedule',
        triggerName: 'Nightly audit',
        flowName: 'audit',
        inputs: { scope: 'auth', depth: 'deep' },
        // Stale fields an issue run would show: they are not rendered here.
        reviews: [verdict('aaa1111ff', true, 't-rev-1')],
        triage: { decision: 'ready', at: new Date().toISOString() },
      }),
    );
    expect(screen.getByTestId('factory-run-detail-ref').textContent).toBe('Nightly audit');
    expect(screen.getByTestId('factory-run-detail-title').textContent).toBe(
      'Nightly audit · audit',
    );
    expect(screen.getByTestId('factory-run-detail-input-scope')).toHaveTextContent('auth');
    expect(screen.getByTestId('factory-run-detail-input-depth')).toHaveTextContent('deep');
    for (const section of ['triage', 'reviews']) {
      expect(screen.queryByTestId(`factory-run-detail-${section}`)).toBeNull();
    }
  });

  test('an issue run lists no inputs', () => {
    renderBody(queueRun({ state: 'working' }));
    expect(screen.queryByTestId('factory-run-detail-inputs')).toBeNull();
    expect(screen.getByTestId('factory-run-detail-ref').textContent).toBe('#1');
  });

  // openspec factory-merge-fewer-bounces: "The run panel shows what changed since an approval".
  test('a run held again shows what changed since the approved commit, above its risk', () => {
    const held = {
      state: 'waiting_human' as const,
      failureReason: 'high risk',
      prUrl: 'https://github.com/o/r/pull/9',
      risk: { headSha: 'b'.repeat(40), level: 'high' as const, reasons: ['size'], paths: [] },
    };
    renderBody(
      queueRun({
        ...held,
        mergeApproval: {
          sha: 'a'.repeat(40),
          userId: 'u1',
          at: '2026-11-24T10:00:00.000Z',
          gap: {
            to: 'b'.repeat(40),
            at: '2026-11-24T11:00:00.000Z',
            lines: 8,
            files: ['src/new.ts'],
            moreFiles: 0,
            newFiles: ['src/new.ts'],
            newRiskKeys: ['ci'],
            reason: 'the change now touches src/new.ts, which the approved commit did not',
          },
        },
      }),
    );
    const gap = screen.getByTestId('factory-run-detail-approval-gap');
    expect(gap.textContent).toContain('You approved aaaaaaa');
    expect(gap.textContent).toContain('8 lines of the change differ');
    expect(gap.textContent).toContain('src/new.tsnot in the approved change');
    expect(screen.getByTestId('factory-run-detail-approval-gap-risks').textContent).toContain('ci');
    const risk = screen.getByTestId('factory-run-detail-risk');
    expect(gap.compareDocumentPosition(risk) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // openspec factory-approval-follows-base-code: a file the base brought is not flagged as new.
  test('a file the base brought is told apart from one outside the approved change', () => {
    renderBody(
      queueRun({
        state: 'waiting_human',
        failureReason: 'high risk',
        risk: { headSha: 'b'.repeat(40), level: 'high', reasons: ['size'], paths: [] },
        mergeApproval: {
          sha: 'a'.repeat(40),
          userId: 'u1',
          at: '2026-11-24T10:00:00.000Z',
          gap: {
            to: 'b'.repeat(40),
            at: '2026-11-24T11:00:00.000Z',
            lines: 120,
            files: ['src/fixed.ts', 'src/new.ts'],
            moreFiles: 0,
            newFiles: ['src/fixed.ts', 'src/new.ts'],
            baseFiles: ['src/fixed.ts'],
            newRiskKeys: [],
            reason: 'the change differs from the approved commit by 120 lines',
          },
        },
      }),
    );
    const files = screen.getByTestId('factory-run-detail-approval-gap-files').textContent;
    expect(files).toContain('src/fixed.tscode the base brought');
    expect(files).toContain('src/new.tsnot in the approved change');
  });

  test('a first hold shows its risk and no difference', () => {
    renderBody(
      queueRun({
        state: 'waiting_human',
        failureReason: 'high risk',
        risk: { headSha: 'b'.repeat(40), level: 'high', reasons: ['size'], paths: [] },
      }),
    );
    expect(screen.getByTestId('factory-run-detail-risk')).toBeTruthy();
    expect(screen.queryByTestId('factory-run-detail-approval-gap')).toBeNull();
  });

  // openspec factory-approval-survives-integration, 5.2.
  test('a merge approval shows the commit a member approved and where it moved', () => {
    renderBody(
      queueRun({
        state: 'merging',
        mergeApproval: {
          sha: 'c'.repeat(40),
          userId: 'u1',
          at: '2026-11-24T10:00:00.000Z',
          carriedFrom: 'a'.repeat(40),
          moves: [
            {
              to: 'b'.repeat(40),
              at: '2026-11-24T11:00:00.000Z',
              kind: 'same',
              lines: 0,
              files: [],
            },
            {
              to: 'c'.repeat(40),
              at: '2026-11-24T12:00:00.000Z',
              kind: 'adjustment',
              lines: 7,
              files: ['src/a.ts', 'src/b.ts'],
            },
          ],
        },
      }),
    );
    const approval = screen.getByTestId('factory-run-detail-approval');
    expect(approval.textContent).toContain('Merge approved at aaaaaaa');
    expect(screen.getByTestId('factory-run-detail-approval-move-0').textContent).toBe(
      'moved to bbbbbbb · same change',
    );
    expect(screen.getByTestId('factory-run-detail-approval-move-1').textContent).toBe(
      'moved to ccccccc · 7 lines differ in 2 files',
    );
  });

  test('a run that reached nothing yet shows only its header', () => {
    renderBody(queueRun({ state: 'requested' }));
    expect(screen.getByTestId('factory-run-detail-title')).toBeTruthy();
    for (const section of ['triage', 'reviews', 'risk-ci', 'threads', 'flow']) {
      expect(screen.queryByTestId(`factory-run-detail-${section}`)).toBeNull();
    }
  });
});

describe('the step timeline', () => {
  test('a retried step with both attempts, and a 15 min wait before merge', () => {
    const minAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
    renderBody(
      queueRun({
        state: 'merging',
        currentStep: 'merge',
        stepTimings: [
          {
            step: 'ci',
            visit: '1',
            attempt: 1,
            status: 'failed',
            startedAt: minAgo(100),
            finishedAt: minAgo(90),
          },
          {
            step: 'ci',
            visit: '1',
            attempt: 2,
            status: 'succeeded',
            startedAt: minAgo(90),
            finishedAt: minAgo(80),
          },
          {
            step: 'review',
            visit: '1',
            attempt: 1,
            status: 'succeeded',
            startedAt: minAgo(80),
            finishedAt: minAgo(60),
          },
          {
            step: 'merge',
            visit: '1',
            attempt: 1,
            status: 'running',
            startedAt: minAgo(45),
            finishedAt: null,
          },
        ],
      }),
    );
    expect(screen.getByTestId('factory-run-detail-timing-0')).toHaveTextContent('failed');
    expect(screen.getByTestId('factory-run-detail-timing-1')).toHaveTextContent('attempt 2');
    expect(screen.getByTestId('factory-run-detail-timing-1')).toHaveTextContent('10m');
    expect(screen.getByTestId('factory-run-detail-wait-3')).toHaveTextContent('waited 15m');
    expect(screen.queryByTestId('factory-run-detail-wait-1')).toBeNull();
  });

  test('without timings: no durations, the flow steps with their state', () => {
    renderBody(queueRun({ state: 'working' }));
    expect(screen.queryByTestId('factory-run-detail-timing-0')).toBeNull();
  });

  test('one Flow tab: the timed steps, then the steps not reached', () => {
    const minAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
    renderBody(
      queueRun({
        state: 'working',
        currentStep: 'implement',
        flowSteps: ['triage', 'implement', 'merge'],
        stepTimings: [
          {
            step: 'triage',
            visit: '1',
            attempt: 1,
            status: 'succeeded',
            startedAt: minAgo(10),
            finishedAt: minAgo(8),
          },
        ],
      }),
    );
    expect(screen.queryByTestId('factory-run-detail-tab-timeline')).toBeNull();
    expect(screen.getByTestId('factory-run-detail-timing-0')).toHaveTextContent('triage');
    expect(screen.getByTestId('factory-run-detail-step-merge').dataset.status).toBe('pending');
  });
});

describe('the run search parameter', () => {
  test('a link to a listed run opens its panel; closing removes the parameter', async () => {
    mocks.queue = [queueRun({ id: 'r1', state: 'working' })];
    renderView('/factory?run=r1');
    expect(await screen.findByTestId('factory-run-detail')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('factory-run-detail'), { key: 'Escape' });
    await waitFor(() => expect(location).toBe('/factory'));
  });

  test('a run that is not listed opens nothing and the parameter goes away', async () => {
    mocks.queue = [queueRun({ id: 'r1' })];
    renderView('/factory?run=gone');
    await waitFor(() => expect(location).toBe('/factory'));
    expect(screen.queryByTestId('factory-run-detail')).toBeNull();
  });

  test('while the runs load, the parameter is kept', () => {
    mocks.queue = undefined;
    renderView('/factory?run=r1');
    expect(location).toBe('/factory?run=r1');
  });

  test('the list row details button opens the panel, and the panel follows the run', async () => {
    mocks.queue = [queueRun({ id: 'r1', state: 'reviewing' })];
    const view = renderView('/factory');
    fireEvent.click(screen.getByTestId('factory-view-details-r1'));
    expect(await screen.findByTestId('factory-run-detail-state')).toHaveTextContent('In review');
    expect(location).toBe('/factory?run=r1');
    mocks.queue = [queueRun({ id: 'r1', state: 'merging' })];
    act(() => {
      view.rerender(
        <MemoryRouter initialEntries={['/factory?run=r1']}>
          <TooltipProvider>
            <FactoryQueueView />
            <LocationProbe />
          </TooltipProvider>
        </MemoryRouter>,
      );
    });
    expect(screen.getByTestId('factory-run-detail-state')).toHaveTextContent('In the merge lane');
  });
});

describe('the analytics layout', () => {
  test('the list header shows no health figures', () => {
    mocks.queue = [queueRun({ id: 'a', state: 'working' })];
    renderView('/factory?view=list');
    expect(screen.queryByTestId('factory-view-health')).toBeNull();
    expect(screen.queryByTestId('factory-metrics')).toBeNull();
  });

  test('its health figures cover every listed run, whatever the filters', () => {
    mocks.queue = [
      queueRun({ id: 'a', state: 'working' }),
      queueRun({ id: 'b', state: 'failed', projectId: 'p2' }),
    ];
    renderView('/factory?view=analytics');
    expect(screen.getByTestId('factory-view-health-in-flight')).toHaveTextContent('1');
    fireEvent.click(screen.getByTestId('factory-view-active-filter'));
    fireEvent.click(screen.getByTestId('factory-view-show-active'));
    fireEvent.change(screen.getByTestId('factory-view-search-input'), {
      target: { value: '#999' },
    });
    expect(screen.getByTestId('factory-view-health-in-flight')).toHaveTextContent('1');
    expect(screen.getByTestId('factory-view-health-needs-person')).toHaveTextContent('1');
    expect(screen.getByTestId('factory-view-health-first-pass')).toHaveTextContent('—');
  });

  test('a banner for the project whose factory has an open incident, none for the other', () => {
    mocks.queue = [queueRun({ id: 'a' }), queueRun({ id: 'b', projectId: 'p2' })];
    mocks.incidents = {
      p2: {
        id: 'i1',
        repo: 'acme/app',
        baseBranch: 'main',
        state: 'reported',
        redSha: 'abc',
        openedAt: new Date().toISOString(),
        closedAt: null,
        candidates: [],
        result: {
          decision: 'revert',
          reason: 'the tests broke',
          culpritPrUrl: 'https://github.com/acme/app/pull/34',
          revertPrUrl: 'https://github.com/acme/app/pull/50',
        },
      },
    };
    renderView('/factory');
    expect(screen.queryByTestId('factory-view-incident-p1')).toBeNull();
    const banner = screen.getByTestId('factory-view-incident-p2');
    expect(banner).toHaveTextContent('main');
    expect(banner).toHaveTextContent('acme/app');
    expect(screen.getByTestId('factory-view-incident-p2-culprit').getAttribute('href')).toContain(
      '/pull/34',
    );
    expect(screen.getByTestId('factory-view-incident-p2-revert').getAttribute('href')).toContain(
      '/pull/50',
    );
    expect(screen.getByTestId('factory-view-incident-p2-close')).toBeTruthy();
  });
});

describe('the run panel tabs', () => {
  test('one tab per section with something to show; a section shows when its tab is picked', () => {
    renderBody(
      queueRun({
        state: 'reviewing',
        triage: {
          decision: 'ready',
          at: new Date().toISOString(),
          threadId: 't-tri',
          items: ['Must pass lint'],
        },
        reviews: [verdict('aaa1111ff', true, 't-rev-1')],
      }),
    );
    const tabs = screen.getByTestId('factory-run-detail-tabs');
    expect(within(tabs).getByTestId('factory-run-detail-tab-triage')).toBeTruthy();
    expect(within(tabs).getByTestId('factory-run-detail-tab-reviews')).toBeTruthy();
    // No proof yet: no tab for it.
    expect(within(tabs).queryByTestId('factory-run-detail-tab-proof')).toBeNull();
    // Only the picked tab's section is shown.
    expect(screen.queryByTestId('factory-run-detail-reviews')).toBeNull();
    fireEvent.mouseDown(screen.getByTestId('factory-run-detail-tab-reviews'), { button: 0 });
    expect(screen.getByTestId('factory-run-detail-reviews')).toBeTruthy();
  });
});

describe('the agent threads tab', () => {
  test('every row reads role, steps and "Thread"; a loaded thread\'s title stays out of the row', () => {
    mocks.threads = {
      't-impl': { id: 't-impl', title: '[Factory] #479 A very long thread title' },
    };
    renderBody(
      queueRun({
        state: 'working',
        threadIds: ['t-impl'],
        stepOptions: [
          {
            stepId: 'implement',
            threadId: 't-impl',
            provider: 'claude',
            model: 'opus',
            effort: null,
            permissionMode: 'autoEdit',
            allowedTools: null,
            disallowedTools: null,
            thread: 'continue',
          },
        ],
      }),
    );
    fireEvent.mouseDown(screen.getByTestId('factory-run-detail-tab-threads'), { button: 0 });
    const link = screen.getByTestId('factory-run-detail-thread-t-impl');
    expect(link).toHaveTextContent('Thread');
    const row = link.closest('li')!;
    expect(row).toHaveTextContent('implement');
    expect(row).not.toHaveTextContent('A very long thread title');
    mocks.threads = {};
  });
});
