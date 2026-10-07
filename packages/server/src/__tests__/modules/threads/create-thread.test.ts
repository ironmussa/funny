/**
 * Use-case tests with in-memory fakes. No Hono, database, or runner is involved.
 */
import { describe, expect, test } from 'bun:test';

import { makeCreateThread } from '../../../modules/threads/application/create-thread.js';
import type {
  ActorContext,
  CreateThreadPorts,
  CreationIntent,
  RemoteCreationResponse,
  ThreadRegistration,
} from '../../../modules/threads/application/ports.js';
import type { CreationTarget } from '../../../modules/threads/domain/creation-target.js';
import { authenticatedUserId, resolvedRunnerId } from '../../../modules/threads/domain/ids.js';

interface FakeOptions {
  runnerId?: string | null;
  resolveError?: Error;
  response?: RemoteCreationResponse;
  remoteError?: Error;
  registerError?: Error;
  cacheError?: Error;
}

function fakes(opts: FakeOptions = {}) {
  const effects: string[] = [];
  const resolveCalls: Array<{
    actor: ActorContext;
    target: CreationTarget;
    intent: CreationIntent;
  }> = [];
  const remoteCalls: Array<{ runnerId: string; intent: CreationIntent; payload: unknown }> = [];
  const registrations: ThreadRegistration[] = [];
  const cached: Array<[string, string, string]> = [];

  const ports: CreateThreadPorts = {
    runners: {
      async resolve(actor, target, intent) {
        effects.push('resolve');
        resolveCalls.push({ actor, target, intent });
        if (opts.resolveError) throw opts.resolveError;
        const id = opts.runnerId === undefined ? 'runner-1' : opts.runnerId;
        return id
          ? { ok: true, runnerId: resolvedRunnerId(id) }
          : { ok: false, reason: 'general-runner-offline' };
      },
    },
    remote: {
      async create(runnerId, _actor, intent, payload) {
        effects.push('remote');
        remoteCalls.push({ runnerId, intent, payload });
        if (opts.remoteError) throw opts.remoteError;
        return opts.response ?? { ok: true, thread: { id: 't1', branch: 'rt/b' } };
      },
    },
    registry: {
      async register(entry) {
        effects.push('register');
        if (opts.registerError) throw opts.registerError;
        registrations.push(entry);
      },
    },
    routingCache: {
      remember(threadId, userId, runnerId) {
        effects.push('cache');
        if (opts.cacheError) throw opts.cacheError;
        cached.push([threadId, userId, runnerId]);
      },
    },
  };
  return { ports, effects, resolveCalls, remoteCalls, registrations, cached };
}

const actor: ActorContext = { userId: authenticatedUserId('user-1') };

describe('createThread use case', () => {
  test.each(['normal', 'idle'] as const)('%s intent runs the full sequence', async (intent) => {
    const f = fakes();
    const result = await makeCreateThread(f.ports)({ actor, intent, payload: { projectId: 'p1' } });
    expect(result._unsafeUnwrap()).toEqual({
      thread: { id: 't1', branch: 'rt/b' },
      threadId: 't1',
      runnerId: 'runner-1',
    } as any);
    expect(f.effects).toEqual(['resolve', 'remote', 'register', 'cache']);
    expect(f.resolveCalls[0].intent).toBe(intent);
    expect(f.remoteCalls[0].intent).toBe(intent);
    expect(f.cached).toEqual([['t1', 'user-1', 'runner-1']]);
  });

  test('normalization failure performs no I/O', async () => {
    const f = fakes();
    const result = await makeCreateThread(f.ports)({
      actor,
      intent: 'normal',
      payload: { isScratch: true, projectId: 'p1' },
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'rejected',
      code: 'scratch-thread-cannot-have-project',
      message: 'Scratch threads cannot have a project',
    });
    expect(f.effects).toEqual([]);
  });

  test('scratch target is resolved and forwarded normalized', async () => {
    const f = fakes();
    await makeCreateThread(f.ports)({ actor, intent: 'normal', payload: { isScratch: true } });
    expect(f.resolveCalls[0].target).toEqual({ kind: 'scratch', mode: 'local' });
    expect(f.remoteCalls[0].payload).toEqual({ isScratch: true, projectId: null, mode: 'local' });
    expect(f.registrations[0]).toMatchObject({ projectId: null, isScratch: true, mode: 'local' });
  });

  test('no runner → no-runner failure scoped by target', async () => {
    const project = fakes({ runnerId: null });
    expect(
      (
        await makeCreateThread(project.ports)({
          actor,
          intent: 'normal',
          payload: { projectId: 'p' },
        })
      )._unsafeUnwrapErr(),
    ).toEqual({ kind: 'no-runner', scope: 'project', reason: 'general-runner-offline' });
    expect(project.effects).toEqual(['resolve']);

    const scratch = fakes({ runnerId: null });
    expect(
      (
        await makeCreateThread(scratch.ports)({
          actor,
          intent: 'idle',
          payload: { isScratch: true },
        })
      )._unsafeUnwrapErr(),
    ).toEqual({ kind: 'no-runner', scope: 'user', reason: 'general-runner-offline' });
  });

  test('resolver exceptions propagate instead of becoming creation-failed', async () => {
    const f = fakes({ resolveError: new Error('db down') });
    await expect(
      makeCreateThread(f.ports)({ actor, intent: 'normal', payload: { projectId: 'p' } }),
    ).rejects.toThrow('db down');
  });

  test('remote error is returned without registration', async () => {
    const f = fakes({ response: { ok: false, status: 422, message: 'bad' } });
    const result = await makeCreateThread(f.ports)({
      actor,
      intent: 'normal',
      payload: { projectId: 'p' },
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'remote-error',
      status: 422,
      message: 'bad',
    });
    expect(f.effects).toEqual(['resolve', 'remote']);
  });

  test('metadata precedence: top-level id, runtime branch, body title, typed fields', async () => {
    const f = fakes({
      response: {
        ok: true,
        thread: { id: 'top', thread: { id: 'nested' }, title: 'RT', branch: 'rt' },
      },
    });
    await makeCreateThread(f.ports)({
      actor,
      intent: 'normal',
      payload: { projectId: 'p1', title: 'Body', model: 'opus', mode: 3, branch: 'body' },
    });
    expect(f.registrations[0]).toEqual({
      id: 'top',
      projectId: 'p1',
      runnerId: 'runner-1',
      userId: 'user-1',
      title: 'Body',
      model: 'opus',
      mode: undefined,
      branch: 'rt',
      isScratch: false,
    } as unknown as ThreadRegistration);
  });

  test('metadata fallback: nested id, runtime title, body branch', async () => {
    const f = fakes({ response: { ok: true, thread: { thread: { id: 'nested' }, title: 'RT' } } });
    await makeCreateThread(f.ports)({
      actor,
      intent: 'normal',
      payload: { projectId: 'p1', title: '', branch: 'body' },
    });
    expect(f.registrations[0]).toMatchObject({ id: 'nested', title: 'RT', branch: 'body' });
  });

  test('missing id skips registration and cache', async () => {
    const f = fakes({ response: { ok: true, thread: { ok: true } } });
    const result = await makeCreateThread(f.ports)({
      actor,
      intent: 'normal',
      payload: { projectId: 'p' },
    });
    expect(result.isOk()).toBe(true);
    expect(f.effects).toEqual(['resolve', 'remote']);
  });

  test('default runner bypasses registration and cache', async () => {
    const f = fakes({ runnerId: '__default__' });
    const result = await makeCreateThread(f.ports)({
      actor,
      intent: 'normal',
      payload: { projectId: 'p' },
    });
    expect(result.isOk()).toBe(true);
    expect(f.effects).toEqual(['resolve', 'remote']);
  });

  test.each([
    ['remote throws', { remoteError: new Error('x') }, ['resolve', 'remote']],
    ['null runner body', { response: { ok: true, thread: null } }, ['resolve', 'remote']],
    ['registry throws', { registerError: new Error('x') }, ['resolve', 'remote', 'register']],
    ['cache throws', { cacheError: new Error('x') }, ['resolve', 'remote', 'register', 'cache']],
  ] as const)('%s → creation-failed with partial effects', async (_name, opts, effects) => {
    const f = fakes(opts as FakeOptions);
    const result = await makeCreateThread(f.ports)({
      actor,
      intent: 'normal',
      payload: { projectId: 'p' },
    });
    expect(result._unsafeUnwrapErr().kind).toBe('creation-failed');
    expect(f.effects).toEqual([...effects]);
  });
});
