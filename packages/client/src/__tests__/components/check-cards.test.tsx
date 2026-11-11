import { checkInputKey } from '@funny/shared/checks';
import { screen, waitFor } from '@testing-library/react';
import { ok, err } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { BashCheckCard, CheckRunCard } from '@/components/tool-cards/check-cards';
import { useCheckRunsStore } from '@/stores/check-runs-store';

import { renderWithProviders } from '../helpers/render';

const apiMock = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: apiMock }));

const THREAD = 'thread-1';
const PATH = '/tmp/funny-u1/checks/run1.json';

const testRun = (status: 'running' | 'failed') =>
  JSON.stringify({
    version: 1,
    status,
    startedAt: 1_000,
    updatedAt: 2_000,
    suites: [
      {
        name: 'vitest',
        status,
        related: false,
        passed: 4,
        failed: 1,
        skipped: 0,
        running: [],
        slow: [],
        failures: [{ name: 'a > breaks', file: 'src/a.test.ts', line: 9 }],
      },
    ],
  });

/** The MCP envelope a finished call's output is stored as. */
const envelope = (text: string) => JSON.stringify({ content: [{ type: 'text', text }] });

const renderRun = (parsed: Record<string, unknown>, output?: string) =>
  renderWithProviders(<CheckRunCard parsed={parsed} output={output} displayTime={null} />, {
    threadId: THREAD,
  });

beforeEach(() => {
  apiMock.readFile.mockReset();
  useCheckRunsStore.setState({ byThread: {} });
});

describe('CheckRunCard', () => {
  test('a running call follows the file the runner announced for its input', async () => {
    apiMock.readFile.mockResolvedValue(ok({ content: testRun('running') }));
    useCheckRunsStore.getState().record(THREAD, {
      runId: 'run1',
      kind: 'test',
      path: PATH,
      inputKey: checkInputKey({ kind: 'test' }),
      startedAt: 1_000,
    });
    renderRun({ kind: 'test' });
    await waitFor(() => expect(apiMock.readFile).toHaveBeenCalledWith(PATH));
    expect(await screen.findByTestId('test-progress')).toBeTruthy();
  });

  test('before the announcement it shows that the run is starting', () => {
    renderRun({ kind: 'lint' });
    expect(screen.getByTestId('check-run-starting')).toBeTruthy();
    expect(apiMock.readFile).not.toHaveBeenCalled();
  });

  test('a finished call reads the progress path from its result, after a reload', async () => {
    apiMock.readFile.mockResolvedValue(ok({ content: testRun('failed') }));
    renderRun({ kind: 'test' }, envelope(`test FAILED (exit 1, 2.0s)\nprogressPath: ${PATH}`));
    await waitFor(() => expect(apiMock.readFile).toHaveBeenCalledWith(PATH));
    expect(await screen.findByTestId('test-progress')).toBeTruthy();
  });

  test('when the file is gone, the summary shows instead of an error', async () => {
    apiMock.readFile.mockResolvedValue(err(new Error('ENOENT')));
    renderRun(
      { kind: 'lint' },
      envelope(`lint FAILED (exit 1, 1.0s)\nerror src/a.ts:3:5 nope\nprogressPath: ${PATH}`),
    );
    const summary = await screen.findByTestId('check-run-summary');
    expect(summary.textContent).toContain('error src/a.ts:3:5 nope');
  });

  test('a call that could not run shows its message', () => {
    renderRun(
      { kind: 'lint' },
      envelope('No lint command detected in /repo. Pass "command" to run one.'),
    );
    expect(screen.getByTestId('check-run-summary').textContent).toContain(
      'No lint command detected',
    );
  });
});

describe('BashCheckCard', () => {
  const renderBash = (command: string, output: string) =>
    renderWithProviders(<BashCheckCard parsed={{ command }} output={output} displayTime={null} />);

  test('vitest through Bash shows its totals and failures', () => {
    renderBash(
      'npx vitest run',
      'Exit code 1\n ❯ src/a.test.ts (3 tests | 1 failed)\n FAIL  src/a.test.ts > a > breaks\nError: nope\n      Tests  1 failed | 2 passed (3)',
    );
    expect(screen.getByTestId('check-result-card')).toBeTruthy();
    expect(screen.getByTestId('test-progress')).toBeTruthy();
  });

  test('tsc errors through Bash show as a task run', () => {
    renderBash(
      'bunx tsc --noEmit',
      'Exit code 2\nsrc/a.ts(3,5): error TS2322: Type number is not assignable.',
    );
    expect(screen.getByTestId('task-progress')).toBeTruthy();
  });

  test.each([
    ['a truncated test log', 'npx vitest run 2>&1 | head -3', ' ✓ src/a.test.ts (5 tests) 120ms'],
    ['a command that is not a check', 'ls -la', 'total 0'],
  ])('%s stays a plain Bash card', (_case, command, output) => {
    renderBash(command, output);
    expect(screen.queryByTestId('check-result-card')).toBeNull();
  });
});
