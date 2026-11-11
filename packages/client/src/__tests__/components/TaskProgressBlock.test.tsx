import type { TaskProgress } from '@funny/shared/task-progress';
import { act, screen } from '@testing-library/react';
import { ok } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { TaskProgressBlock } from '@/components/TaskProgressBlock';
import { PROGRESS_POLL_MS } from '@/hooks/use-progress-file';

import { renderWithProviders } from '../helpers/render';

const apiMock = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: apiMock }));

const PATH = '/tmp/funny-u1/task-lint.json';

function progress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    version: 1,
    title: 'typecheck',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 5_000,
    concurrency: 4,
    steps: [
      {
        id: 'bun scripts/fitness/check-typecheck.ts',
        name: 'check-typecheck',
        status: 'running',
        startedAt: 2_000,
        errors: 0,
        warnings: 0,
        unitsDone: 6,
        unitsTotal: 15,
        current: 'packages/client/tsconfig.json',
        tail: [],
      },
      {
        id: 'oxlint .',
        name: 'oxlint .',
        status: 'passed',
        durationMs: 16_000,
        errors: 0,
        warnings: 2,
        tail: [],
      },
      {
        id: 'bun run lint:proofs',
        name: 'lint:proofs',
        status: 'failed',
        durationMs: 3_000,
        errors: 0,
        warnings: 0,
        tail: ['✗ forged cast was accepted', 'exit 1'],
      },
    ],
    issues: [
      {
        step: 'oxlint .',
        severity: 'warning',
        file: 'src/a.ts',
        line: 3,
        column: 7,
        message: 'unused',
      },
      { step: 'oxlint .', severity: 'error', file: 'src/b.ts', line: 9, message: 'broken' },
    ],
    ...overrides,
  };
}

const respond = (value: TaskProgress) => ok({ content: JSON.stringify(value) });
const flush = () => act(async () => {});

describe('TaskProgressBlock', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(10_000);
    apiMock.readFile.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  test('renders steps, sub-units, counts, issues and a failed step’s output', async () => {
    apiMock.readFile.mockResolvedValue(respond(progress()));
    renderWithProviders(<TaskProgressBlock path={PATH} />);
    await flush();

    expect(screen.getByTestId('task-progress')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('task-progress-running')).toHaveTextContent('1');
    expect(screen.getByTestId('task-progress-steps')).toHaveTextContent('2/3');
    expect(screen.getByTestId('task-progress-units-check-typecheck')).toHaveTextContent('6/15');
    expect(screen.getByTestId('task-progress-warnings')).toHaveTextContent('2');
    expect(screen.getByTestId('task-progress-tail-lint:proofs')).toHaveTextContent(
      'forged cast was accepted',
    );
    const issues = screen.getByTestId('task-progress-issues');
    expect(issues).toHaveTextContent('src/a.ts:3:7');
    expect(issues).toHaveTextContent('src/b.ts:9');
  });

  test('polls while running and stops once the task finishes', async () => {
    apiMock.readFile
      .mockResolvedValueOnce(respond(progress()))
      .mockResolvedValue(respond(progress({ status: 'failed', finishedAt: 9_000 })));
    renderWithProviders(<TaskProgressBlock path={PATH} />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_POLL_MS);
    });
    await flush();
    expect(screen.getByTestId('task-progress')).toHaveAttribute('data-status', 'failed');
    expect(screen.queryByTestId('task-progress-running')).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_POLL_MS * 5);
    });
    expect(apiMock.readFile).toHaveBeenCalledTimes(2);
  });

  test('shows an error for an invalid fence without reading anything', () => {
    renderWithProviders(<TaskProgressBlock path={null} />);
    expect(screen.getByTestId('task-progress-error')).toBeInTheDocument();
    expect(apiMock.readFile).not.toHaveBeenCalled();
  });
});
