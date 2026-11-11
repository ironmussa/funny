import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkInputKey } from '@funny/shared/checks';
import { parseTestProgress } from '@funny/shared/test-progress';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { getThread, getProject, emitToUser, spawnJob, assets } = vi.hoisted(() => ({
  getThread: vi.fn(),
  getProject: vi.fn(),
  emitToUser: vi.fn(),
  spawnJob: vi.fn(),
  assets: { dir: '' },
}));

vi.mock('../../../services/service-registry.js', () => ({
  getServices: () => ({ threads: { getThread }, projects: { getProject } }),
}));
vi.mock('../../../services/ws-broker.js', () => ({ wsBroker: { emitToUser } }));
vi.mock('../../../services/agent-job-manager.js', () => ({ spawnJob }));
vi.mock('../../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../services/thread-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/thread-context.js')>()),
  tmpAssetsPathFor: () => assets.dir,
}));

import type { AgentToolResult } from '../../../services/agent-mcp-http.js';
import { checkToolDefinition } from '../../../services/checks/check-tool.js';

const THREAD = 'thread-1';
const USER = 'user-1';
let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'funny-check-tool-project-'));
  assets.dir = mkdtempSync(join(tmpdir(), 'funny-check-tool-assets-'));
  getThread.mockResolvedValue({ id: THREAD, userId: USER, projectId: 'p1', mode: 'local' });
  getProject.mockResolvedValue({ id: 'p1', path: project });
  spawnJob.mockResolvedValue({ id: 'job-1' });
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(assets.dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const run = (args: Record<string, unknown>) =>
  checkToolDefinition(THREAD, USER).run(args, { signal: new AbortController().signal });

/** A package.json whose test script prints `output` and exits with `code`. */
function testScript(output: string, code = 0): void {
  const file = join(project, 'out.txt');
  writeFileSync(file, output);
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ scripts: { test: `cat out.txt; exit ${code}` } }),
  );
}

const textOf = (result: AgentToolResult) =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

const progressPathOf = (result: AgentToolResult) => /progressPath: (\S+)/.exec(textOf(result))![1];

describe('funny_run_checks', () => {
  test('runs the detected command in the thread cwd and answers with a summary', async () => {
    testScript(
      ' ❯ src/a.test.ts (2 tests | 1 failed)\n FAIL  src/a.test.ts > breaks\nError: nope\n ❯ src/a.test.ts:4:1\n      Tests  1 failed | 1 passed (2)',
      1,
    );
    const result = await run({ kind: 'test' });
    const body = textOf(result);
    expect(body).toContain('test FAILED (exit 1');
    expect(body).toContain('$ npm run test');
    expect(body).toContain('✗ src/a.test.ts:4 breaks — Error: nope');
    expect(body).not.toContain('Tests  1 failed'); // the raw log stays out

    const path = progressPathOf(result);
    expect(path.startsWith(join(assets.dir, 'checks'))).toBe(true);
    const progress = parseTestProgress(readFileSync(path, 'utf8'));
    expect(progress.ok && progress.value.status).toBe('failed');
  });

  test('announces the run to the thread with the key of its input', async () => {
    testScript('      Tests  1 passed (1)');
    const result = await run({ kind: 'test', scope: [] });
    expect(emitToUser).toHaveBeenCalledWith(USER, {
      type: 'agent:check_run',
      threadId: THREAD,
      data: expect.objectContaining({
        kind: 'test',
        path: progressPathOf(result),
        inputKey: checkInputKey({ kind: 'test' }),
      }),
    });
  });

  test('a project with nothing to run says what it looked for', async () => {
    writeFileSync(join(project, 'package.json'), '{}');
    const result = await run({ kind: 'lint' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Pass "command"');
    expect(emitToUser).not.toHaveBeenCalled();
  });

  test('an exact command runs as given', async () => {
    const result = await run({ kind: 'lint', command: "printf 'All checks passed!\\n'" });
    expect(textOf(result)).toMatch(/^lint PASSED/);
  });

  test('background runs start a job that runs the plan and wake with its summary', async () => {
    testScript('      Tests  1 passed (1)');
    const result = await run({ kind: 'test', background: true });
    expect(textOf(result)).toContain('job job-1');
    const [{ command, cwd, threadId, userId }] = spawnJob.mock.calls[0];
    expect({ cwd, threadId, userId }).toEqual({ cwd: project, threadId: THREAD, userId: USER });
    const spec = /'([^']+\.plan\.json)'/.exec(command)![1];
    expect(existsSync(spec)).toBe(true);
    expect(JSON.parse(readFileSync(spec, 'utf8'))).toMatchObject({
      plan: { kind: 'test', steps: [{ command: 'npm run test' }] },
      progressPath: progressPathOf(result),
    });
  });

  test('the cwd comes from the thread, never from the arguments', async () => {
    testScript('      Tests  1 passed (1)');
    await run({ kind: 'test', cwd: '/etc' });
    expect(getThread).toHaveBeenCalledWith(THREAD);
  });
});
