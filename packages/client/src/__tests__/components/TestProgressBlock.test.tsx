import type { TestProgress } from '@funny/shared/test-progress';
import { act, screen } from '@testing-library/react';
import { ok, err } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { TestProgressBlock } from '@/components/TestProgressBlock';
import { TEST_PROGRESS_POLL_MS } from '@/hooks/use-test-progress';

import { renderWithProviders } from '../helpers/render';

const apiMock = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: apiMock }));

const PATH = '/tmp/funny-u1/test-progress.json';

function progress(overrides: Partial<TestProgress> = {}): TestProgress {
  return {
    version: 1,
    status: 'running',
    startedAt: 1_000,
    updatedAt: 5_000,
    suites: [
      {
        name: '@funny/shared',
        status: 'passed',
        related: false,
        passed: 90,
        failed: 0,
        skipped: 3,
        durationMs: 4_000,
        running: [],
        slow: [],
      },
      {
        name: '@funny/client',
        status: 'running',
        related: true,
        passed: 12,
        failed: 1,
        skipped: 0,
        startedAt: 2_000,
        current: 'src/__tests__/lib/thread-utils.test.ts',
        running: [],
        slow: [],
      },
      {
        name: '@funny/core',
        status: 'queued',
        related: false,
        passed: 0,
        failed: 0,
        skipped: 0,
        running: [],
        slow: [],
      },
    ],
    ...overrides,
  };
}

const respond = (value: TestProgress) => ok({ content: JSON.stringify(value) });

/** Lets the pending readFile promise and its state update settle. */
const flush = () => act(async () => {});

describe('TestProgressBlock', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(10_000);
    apiMock.readFile.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  test('renders totals, suites and the running suite’s current test', async () => {
    apiMock.readFile.mockResolvedValue(respond(progress()));
    renderWithProviders(<TestProgressBlock path={PATH} />);
    await flush();

    expect(apiMock.readFile).toHaveBeenCalledWith(PATH);
    expect(screen.getByTestId('test-progress')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('test-progress-suites')).toHaveTextContent('1/3');
    expect(screen.getByTestId('test-progress-passed')).toHaveTextContent('102');
    expect(screen.getByTestId('test-progress-failed')).toHaveTextContent('1');
    expect(screen.getByTestId('test-progress-current-@funny/client')).toHaveTextContent(
      'thread-utils.test.ts',
    );
    expect(screen.getByTestId('test-progress-suite-@funny/core')).toHaveAttribute(
      'data-status',
      'queued',
    );
  });

  test('shows runners, files per suite, running files and the slow list', async () => {
    const base = progress({ concurrency: 4 });
    base.suites[1] = {
      ...base.suites[1],
      filesTotal: 40,
      filesDone: 10,
      running: [
        { file: 'src/__tests__/a.test.tsx', startedAt: 8_000 },
        { file: 'src/__tests__/stuck.test.tsx', startedAt: -5_000 },
      ],
      slow: [{ kind: 'file', name: 'src/__tests__/done-slow.test.tsx', durationMs: 12_000 }],
    };
    apiMock.readFile.mockResolvedValue(respond(base));
    renderWithProviders(<TestProgressBlock path={PATH} />);
    await flush();

    expect(screen.getByTestId('test-progress-runners')).toHaveTextContent('1');
    expect(screen.getByTestId('test-progress-runners')).toHaveTextContent('4');
    expect(screen.getByTestId('test-progress-files-@funny/client')).toHaveTextContent('10/40');
    expect(screen.getByTestId('test-progress-activity-@funny/client')).toHaveTextContent(
      'stuck.test.tsx',
    );
    // The file running for 15 s is listed as slow (running), before the finished 12 s one.
    const slow = screen.getByTestId('test-progress-slow');
    expect(slow.textContent?.indexOf('stuck.test.tsx')).toBeLessThan(
      slow.textContent?.indexOf('done-slow.test.tsx') ?? -1,
    );
    // The file running for 2 s is not slow yet.
    expect(slow.querySelectorAll('li')).toHaveLength(2);
  });

  test('polls while running and stops once the run finishes', async () => {
    apiMock.readFile
      .mockResolvedValueOnce(respond(progress()))
      .mockResolvedValue(respond(progress({ status: 'failed', finishedAt: 9_000 })));
    renderWithProviders(<TestProgressBlock path={PATH} />);
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(TEST_PROGRESS_POLL_MS);
    });
    await flush();
    expect(screen.getByTestId('test-progress')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('test-progress-elapsed')).toHaveTextContent('8');

    await act(async () => {
      vi.advanceTimersByTime(TEST_PROGRESS_POLL_MS * 5);
    });
    expect(apiMock.readFile).toHaveBeenCalledTimes(2);
  });

  test('keeps the last snapshot when a later read fails', async () => {
    apiMock.readFile
      .mockResolvedValueOnce(respond(progress()))
      .mockResolvedValue(err(new Error('runner unreachable')));
    renderWithProviders(<TestProgressBlock path={PATH} />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(TEST_PROGRESS_POLL_MS);
    });
    await flush();

    expect(screen.getByTestId('test-progress')).toBeInTheDocument();
    expect(screen.queryByTestId('test-progress-error')).not.toBeInTheDocument();
  });

  test('shows an error for an unreadable file and for an invalid fence', async () => {
    apiMock.readFile.mockResolvedValue(ok({ content: '{"version": 99}' }));
    const { unmount } = renderWithProviders(<TestProgressBlock path={PATH} />);
    await flush();
    expect(screen.getByTestId('test-progress-error')).toHaveTextContent(PATH);
    unmount();

    renderWithProviders(<TestProgressBlock path={null} />);
    expect(screen.getByTestId('test-progress-error')).toBeInTheDocument();
    expect(apiMock.readFile).toHaveBeenCalledTimes(1);
  });
});
