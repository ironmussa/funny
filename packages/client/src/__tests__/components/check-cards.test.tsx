import { checkInputKey } from '@funny/shared/checks';
import { screen, waitFor } from '@testing-library/react';
import { ok, err } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CheckRunCard } from '@/components/tool-cards/check-cards';
import { dispatchToolCard } from '@/components/tool-cards/dispatch';
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

  test('a finished call shows the command it ran', () => {
    apiMock.readFile.mockResolvedValue(ok({ content: testRun('failed') }));
    renderRun(
      { kind: 'test', scope: ['src/a.test.ts'] },
      envelope(
        `test FAILED (exit 1, 2.0s)\n$ bun test src/a.test.ts  (in /repo)\nprogressPath: ${PATH}`,
      ),
    );
    const command = screen.getByTestId('check-run-command');
    expect(command.textContent).toBe('$ bun test src/a.test.ts');
    expect(command.getAttribute('title')).toContain('/repo');
    expect(screen.queryByTestId('check-run-scope')).toBeNull();
  });

  test('a running call shows the scope and filter it asked for', () => {
    renderRun({ kind: 'test', scope: ['src/a.test.ts', 'src/b.test.ts'], filter: 'breaks' });
    const scope = screen.getByTestId('check-run-scope');
    expect(scope.textContent).toContain('src/a.test.ts');
    expect(scope.textContent).toContain('src/b.test.ts');
    expect(scope.textContent).toContain('breaks');
  });

  test('a call without scope, filter or command shows no details', () => {
    renderRun({ kind: 'lint' });
    expect(screen.queryByTestId('check-run-scope')).toBeNull();
    expect(screen.queryByTestId('check-run-command')).toBeNull();
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

describe('dispatchToolCard for checks', () => {
  const card = (name: string, parsed: Record<string, unknown>, output?: string) =>
    renderWithProviders(
      <>
        {dispatchToolCard({ name, parsed, output, displayTime: null, renderToolCall: () => null })}
      </>,
    );

  test('a test run through Bash stays a plain Bash card, without the widget', () => {
    card(
      'Bash',
      { command: 'npx vitest run' },
      ' ❯ src/a.test.ts (3 tests | 1 failed)\n      Tests  1 failed | 2 passed (3)',
    );
    expect(screen.queryByTestId('test-progress')).toBeNull();
    expect(screen.queryByTestId('check-run-card')).toBeNull();
  });

  test('a funny_run_checks call gets the check card', () => {
    card('mcp__funny__funny_run_checks', { kind: 'test' });
    expect(screen.getByTestId('check-run-card')).toBeTruthy();
  });
});
