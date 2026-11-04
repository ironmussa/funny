import type { Thread } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SchedulerView } from '@/components/SchedulerView';
import { seedProjectThreads } from '@/data/threads/testing';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';
import { renderWithProviders } from '../helpers/render';

const api = vi.hoisted(() => ({ listSchedulerRuns: vi.fn(), refreshScheduler: vi.fn() }));
vi.mock('@/lib/api', () => ({ api }));

const failure: DomainError = { type: 'INTERNAL', message: 'scheduler offline' };
const run = (threadId: string, lastEventAtMs: number) => ({
  threadId,
  pipelineRunId: null,
  attempt: 1,
  nextRetryAtMs: null,
  lastEventAtMs,
  lastError: null,
  claimedAtMs: lastEventAtMs,
  userId: 'u1',
  tokensTotal: 0,
  updatedAtMs: lastEventAtMs,
});

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
  seedProjectThreads({ p1: [{ id: 't1', projectId: 'p1', title: 'Fix login' } as Thread] });
});
afterEach(() => resetTestDataLayer());

describe('SchedulerView', () => {
  test('lists the claimed runs, newest event first', async () => {
    api.listSchedulerRuns.mockReturnValue(okAsync({ runs: [run('t1', 1), run('t2', 2)] }));
    renderWithProviders(<SchedulerView />);
    const rows = await screen.findAllByTestId(/^scheduler-run-t/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(['scheduler-run-t2', 'scheduler-run-t1']);
    expect(screen.getByText('Fix login')).toBeInTheDocument();
  });

  test('refresh ticks the scheduler and reloads; a failure shows its message', async () => {
    api.listSchedulerRuns.mockReturnValue(okAsync({ runs: [] }));
    api.refreshScheduler.mockReturnValueOnce(okAsync({ summary: null }));
    renderWithProviders(<SchedulerView />);
    await waitFor(() => expect(api.listSchedulerRuns).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('scheduler-refresh'));
    await waitFor(() => expect(api.listSchedulerRuns).toHaveBeenCalledTimes(2));

    api.refreshScheduler.mockReturnValueOnce(errAsync(failure));
    fireEvent.click(screen.getByTestId('scheduler-refresh'));
    expect(await screen.findByText('scheduler offline')).toBeInTheDocument();
  });
});
