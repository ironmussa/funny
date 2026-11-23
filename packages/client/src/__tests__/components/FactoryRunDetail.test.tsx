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
} => ({ queue: [], navigate: vi.fn(), incidents: {} }))();

mock.module('@/data/factory/hooks', () => ({
  useFactoryQueueRuns: () => mocks.queue,
  useFactorySettings: (projectId: string) =>
    mocks.incidents[projectId] ? { incident: mocks.incidents[projectId] } : null,
}));
mock.module('@/lib/thread-selectors', () => ({ useThreadById: () => undefined }));
mock.module('@/data/projects/hooks', () => ({
  useCanSteerProject: () => true,
  useProjects: () => [{ id: 'p1', name: 'funny' }],
}));
mock.module('@/data/factory/actions', () => ({
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

  test('a run that reached nothing yet shows only its header', () => {
    renderBody(queueRun({ state: 'requested' }));
    expect(screen.getByTestId('factory-run-detail-title')).toBeTruthy();
    for (const section of ['triage', 'reviews', 'risk-ci', 'threads', 'flow']) {
      expect(screen.queryByTestId(`factory-run-detail-${section}`)).toBeNull();
    }
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

describe('the health header', () => {
  test('its figures cover every listed run, whatever the filters', () => {
    mocks.queue = [
      queueRun({ id: 'a', state: 'working' }),
      queueRun({ id: 'b', state: 'failed', projectId: 'p2' }),
    ];
    renderView('/factory');
    expect(screen.getByTestId('factory-view-health-in-flight')).toHaveTextContent('1');
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
