/**
 * The factory view's queue controls and integration figures, moved there from
 * the project settings: Clear queue / Stop all act on the projects the project
 * filter keeps, Stop all asks first, and the figures fold under the header.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryQueueRun, FactoryRun } from '@/lib/api/factory';

const mocks = { empty: vi.fn() };

mock.module('@/data/factory/actions', () => ({
  emptyFactory: (...args: unknown[]) => mocks.empty(...args),
}));
mock.module('@/lib/toast-error', () => ({ toastError: vi.fn() }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string, vars?: Record<string, unknown>) =>
      (fallback ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars?.[name] ?? '')),
  }),
}));

import { FactoryIntegrationStats } from '@/components/factory-board/FactoryIntegrationStats';
import {
  FactoryQueueActions,
  projectsToEmpty,
} from '@/components/factory-board/FactoryQueueActions';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();

const queueRun = (
  id: string,
  projectId: string,
  state: FactoryRun['state'],
  over: Partial<FactoryQueueRun> = {},
): FactoryQueueRun => ({
  ...buildFactoryRun({ id, state, startedAt: hoursAgo(2), completedAt: null }),
  projectId,
  ...over,
});

beforeEach(() => {
  mocks.empty = vi.fn(() => okAsync({ cleared: 0, stopped: 0 }));
});

describe('projectsToEmpty', () => {
  const runs = [
    queueRun('a', 'p1', 'requested'),
    queueRun('b', 'p2', 'working'),
    queueRun('c', 'p3', 'waiting_human'),
    queueRun('d', 'p3', 'merged'),
  ];

  test('clear queue only touches projects with queued issues', () => {
    expect(projectsToEmpty(runs, new Set(), 'clear-queue')).toEqual(['p1']);
  });

  test('stop all touches projects with runs not ended and not waiting for a person', () => {
    expect(projectsToEmpty(runs, new Set(), 'stop-all')).toEqual(['p1', 'p2']);
  });

  test('the project filter limits both', () => {
    expect(projectsToEmpty(runs, new Set(['p2']), 'stop-all')).toEqual(['p2']);
    expect(projectsToEmpty(runs, new Set(['p2']), 'clear-queue')).toEqual([]);
  });
});

describe('FactoryQueueActions', () => {
  test('hidden when nothing can be cleared or stopped', () => {
    render(
      <FactoryQueueActions runs={[queueRun('a', 'p1', 'merged')]} projectFilter={new Set()} />,
    );
    expect(screen.queryByTestId('factory-clear-queue')).toBeNull();
    expect(screen.queryByTestId('factory-stop-all')).toBeNull();
  });

  test('clear queue empties the queue of each project in scope', () => {
    const runs = [queueRun('a', 'p1', 'requested'), queueRun('b', 'p2', 'requested')];
    render(<FactoryQueueActions runs={runs} projectFilter={new Set()} />);
    fireEvent.click(screen.getByTestId('factory-clear-queue'));
    expect(mocks.empty).toHaveBeenCalledTimes(2);
    expect(mocks.empty).toHaveBeenCalledWith('clear-queue', 'p1');
    expect(mocks.empty).toHaveBeenCalledWith('clear-queue', 'p2');
  });

  test('stop all asks for a confirmation first, and keeps to the filtered project', () => {
    const runs = [queueRun('a', 'p1', 'working'), queueRun('b', 'p2', 'working')];
    render(<FactoryQueueActions runs={runs} projectFilter={new Set(['p1'])} />);
    fireEvent.click(screen.getByTestId('factory-stop-all'));
    expect(mocks.empty).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(mocks.empty).toHaveBeenCalledTimes(1);
    expect(mocks.empty).toHaveBeenCalledWith('stop-all', 'p1');
  });
});

describe('FactoryIntegrationStats', () => {
  test('folded by default; opening it shows the figures over the runs', () => {
    const runs = [
      queueRun('a', 'p1', 'merged', { completedAt: hoursAgo(1), admittedAt: hoursAgo(2) }),
      queueRun('b', 'p1', 'failed', { completedAt: hoursAgo(1) }),
    ];
    render(<FactoryIntegrationStats runs={runs} now={NOW} />);
    expect(screen.getByTestId('factory-metrics-toggle')).toHaveTextContent(
      'Integration, last 14 days',
    );
    expect(screen.queryByTestId('factory-metric-runs')).toBeNull();
    fireEvent.click(screen.getByTestId('factory-metrics-toggle'));
    expect(screen.getByTestId('factory-metric-runs')).toHaveTextContent('2');
    expect(screen.getByTestId('factory-metric-merge-rate')).toHaveTextContent('50%');
  });

  test('nothing without runs in the period', () => {
    const old = queueRun('a', 'p1', 'merged', { startedAt: hoursAgo(24 * 20) });
    const { container } = render(<FactoryIntegrationStats runs={[old]} now={NOW} />);
    expect(container.innerHTML).toBe('');
  });
});
