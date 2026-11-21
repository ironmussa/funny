import { afterEach, beforeEach, describe, expect, test, setSystemTime, vi } from 'bun:test';

import type { TaskProgress } from '@funny/shared/task-progress';
import { act, screen } from '@testing-library/react';
import { ok } from 'neverthrow';

import { TaskProgressBlock } from '@/components/TaskProgressBlock';
import { PROGRESS_POLL_MS } from '@/hooks/use-progress-file';

import { renderWithProviders } from '../helpers/render';

const apiMock = (() => ({ readFile: vi.fn() }))();
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
    // bun fakes setTimeout/setInterval and Date together (vitest's `toFake` list).
    vi.useFakeTimers();
    setSystemTime(10_000);
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

  test('shows what a step checked, and "no issues" once it passed clean', async () => {
    apiMock.readFile.mockResolvedValue(
      respond(
        progress({
          status: 'passed',
          finishedAt: 9_000,
          steps: [
            {
              id: 'bunx tsc --noEmit --diagnostics',
              name: 'tsc',
              status: 'passed',
              durationMs: 6_000,
              errors: 0,
              warnings: 0,
              files: 1238,
              lines: 498_796,
              tail: [],
            },
            {
              id: 'bunx oxlint',
              name: 'oxlint',
              status: 'passed',
              durationMs: 1_000,
              errors: 0,
              warnings: 2,
              files: 812,
              rules: 96,
              tail: [],
            },
          ],
          issues: [],
        }),
      ),
    );
    renderWithProviders(<TaskProgressBlock path={PATH} />);
    await flush();

    const tsc = screen.getByTestId('task-progress-stats-tsc');
    expect(tsc).toHaveTextContent('1238 files');
    expect(tsc).toHaveTextContent('lines');
    expect(tsc).toHaveTextContent('No issues');
    const oxlint = screen.getByTestId('task-progress-stats-oxlint');
    expect(oxlint).toHaveTextContent('812 files');
    expect(oxlint).toHaveTextContent('96 rules');
    expect(oxlint).not.toHaveTextContent('No issues');
  });

  test('renders the ANSI colors of a failed tail instead of the raw escapes', async () => {
    const esc = String.fromCharCode(27);
    const base = progress();
    apiMock.readFile.mockResolvedValue(
      respond(
        progress({
          status: 'failed',
          steps: [
            {
              ...base.steps[2],
              name: 'oxfmt',
              status: 'failed',
              tail: [`${esc}[31m1 failed${esc}[39m | <script>x</script>`],
            },
          ],
        }),
      ),
    );
    renderWithProviders(<TaskProgressBlock path={PATH} />);
    await flush();

    const tail = screen.getByTestId('task-progress-tail-oxfmt');
    expect(tail.textContent).toBe('1 failed | <script>x</script>');
    expect(tail.textContent).not.toContain(esc);
    expect(tail.querySelector('span[style*="color"]')).not.toBeNull();
    expect(tail.querySelector('script')).toBeNull();
  });

  test('lists the issues of a failed step that reported them instead of its raw output', async () => {
    const base = progress();
    apiMock.readFile.mockResolvedValue(
      respond(
        progress({
          status: 'failed',
          steps: [
            {
              ...base.steps[0],
              status: 'failed',
              errors: 1,
              tail: ['  src/a.ts: TS2769: No overload matches this call.', 'exit 1'],
            },
          ],
          issues: [
            {
              step: 'check-typecheck',
              severity: 'error',
              file: 'src/a.ts',
              message: 'TS2769: No overload matches this call.',
            },
          ],
        }),
      ),
    );
    renderWithProviders(<TaskProgressBlock path={PATH} />);
    await flush();

    expect(screen.queryByTestId('task-progress-tail-check-typecheck')).toBeNull();
    expect(screen.getByTestId('task-progress-issues')).toHaveTextContent(
      'src/a.ts TS2769: No overload matches this call.',
    );
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
