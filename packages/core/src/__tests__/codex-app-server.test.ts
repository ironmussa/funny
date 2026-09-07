import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { CodexAppServer, codexReviewTarget } from '../agents/codex-app-server.js';

let directory: string;
let binary: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'funny-app-server-'));
  binary = join(directory, 'fixture.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = (message) => console.log(JSON.stringify(message));
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  const { id, method, params } = request;
  if (method === 'initialize') return send({ id, result: {} });
  if (method === 'initialized') return;
  if (method === 'rpc-error') return send({ id, error: { code: -1, message: 'Rejected request' } });
  if (method === 'malformed') return console.log('{invalid');
  if (method === 'exit') return process.exit(1);
  if (method === 'wait') return;
  if (method === 'approval') return send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
  if (id === 'approval') return send({ id: 1, result: request.error });
  const event = (method, body) => send({ method, params: { threadId: params.threadId, ...body } });
  // Ignore a completion from another thread, even when it precedes our own.
  send({ method: 'turn/completed', params: { threadId: 'other', turn: { status: 'failed' } } });
  event('item/completed', { item: { type: 'agentMessage', text: 'Review findings' } });
  event('turn/completed', { turn: { status: method === 'failed' ? 'failed' : 'completed', error: method === 'failed' ? { message: 'Turn failed' } : null } });
  // Completion may arrive before the response that acknowledges the request.
  send({ id, result: {} });
});
`,
  );
  await chmod(binary, 0o755);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function withServer(run: (server: CodexAppServer, abort: AbortController) => Promise<void>) {
  const abort = new AbortController();
  const server = new CodexAppServer(
    directory,
    { ...process.env, CODEX_BINARY_PATH: binary },
    abort.signal,
  );
  try {
    await server.initialize();
    await run(server, abort);
  } finally {
    server.close();
  }
}

describe('Codex App Server', () => {
  test('captures completion before acknowledgement and ignores unrelated threads', async () => {
    await withServer(async (server) => {
      await expect(server.runTurn('review/start', { threadId: 'session' })).resolves.toBe(
        'Review findings',
      );
    });
  });

  test.each([
    ['failed', 'Turn failed'],
    ['rpc-error', 'Rejected request'],
    ['malformed', 'Invalid Codex App Server response'],
    ['exit', 'exited before the operation completed'],
  ])('rejects %s without waiting for the operation timeout', async (method, message) => {
    await withServer(async (server) => {
      await expect(server.runTurn(method, { threadId: 'session' })).rejects.toThrow(message);
    });
  });

  test('aborts a pending operation and rejects subsequent requests', async () => {
    await withServer(async (server, abort) => {
      const completion = expect(server.runTurn('wait', { threadId: 'session' })).rejects.toThrow(
        'cancelled',
      );
      abort.abort();
      await completion;
      await expect(server.request('wait', {})).rejects.toThrow('cancelled');
    });
  });

  test('rejects pending operations when explicitly closed', async () => {
    await withServer(async (server) => {
      const completion = expect(server.runTurn('wait', { threadId: 'session' })).rejects.toThrow(
        'connection closed',
      );
      server.close();
      await completion;
    });
  });

  test('returns an explicit error for interactive approval requests', async () => {
    await withServer(async (server) => {
      await expect(server.request('approval', {})).resolves.toMatchObject({ code: -32601 });
    });
  });
});

test('review targets support working changes, branches, commits and instructions', () => {
  expect(codexReviewTarget('')).toEqual({ type: 'uncommittedChanges' });
  expect(codexReviewTarget('--base develop')).toEqual({ type: 'baseBranch', branch: 'develop' });
  expect(codexReviewTarget('--commit abc')).toEqual({ type: 'commit', sha: 'abc', title: null });
  expect(codexReviewTarget('Check security')).toEqual({
    type: 'custom',
    instructions: 'Check security',
  });
  expect(() => codexReviewTarget('--base')).toThrow('Usage: /review');
});
