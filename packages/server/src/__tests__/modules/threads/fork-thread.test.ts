/**
 * Fork use-case tests with in-memory fakes, for both variants. No Hono,
 * database, or runner is involved.
 */
import { describe, expect, test } from 'bun:test';

import { makeForkThread } from '../../../modules/threads/application/fork-thread.js';
import type {
  ActorContext,
  ForkThreadPorts,
  ForkVariant,
  RemoteCreationResponse,
  ThreadRegistration,
} from '../../../modules/threads/application/ports.js';
import { withForkInputs } from '../../../modules/threads/domain/fork-input.js';
import type { OwnershipForkSource } from '../../../modules/threads/domain/fork-input.js';
import {
  authenticatedUserId,
  authorizedThreadId,
  resolvedRunnerId,
} from '../../../modules/threads/domain/ids.js';
import { threadOwnedBy } from '../../../modules/threads/domain/proofs/thread-owned-by.js';

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
  const resolveCalls: Array<{ actor: ActorContext; projectId: string | null }> = [];
  const remoteCalls: Array<{
    runnerId: string;
    variant: ForkVariant;
    sourceId: string;
    body: string;
    projectId: string | null;
  }> = [];
  const registrations: ThreadRegistration[] = [];
  const cached: Array<[string, string, string]> = [];

  const ports: ForkThreadPorts = {
    runners: {
      async resolve(actor, projectId) {
        effects.push('resolve');
        resolveCalls.push({ actor, projectId });
        if (opts.resolveError) throw opts.resolveError;
        const id = opts.runnerId === undefined ? 'runner-1' : opts.runnerId;
        return id
          ? { ok: true, runnerId: resolvedRunnerId(id) }
          : { ok: false, reason: 'general-runner-offline' };
      },
    },
    remote: {
      async fork(runnerId, _actor, variant, sourceId, body, projectId) {
        effects.push('remote');
        remoteCalls.push({ runnerId, variant, sourceId, body, projectId });
        if (opts.remoteError) throw opts.remoteError;
        return opts.response ?? { ok: true, thread: { id: 't-new', branch: 'rt/b' } };
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
const source = { id: authorizedThreadId('t-source'), projectId: 'p1', ownerId: 'user-1' };
function authorizedFork(ports: ForkThreadPorts) {
  return (command: {
    actor: ActorContext;
    source: OwnershipForkSource;
    variant: ForkVariant;
    body: string;
  }) =>
    withForkInputs(command.actor, command.source, (actor, source) => {
      const ownership = threadOwnedBy(actor, source);
      if (!ownership) throw new Error('Test fixture must own its source');
      return makeForkThread(ports)({ ...command, actor, source, ownership });
    });
}

const VARIANTS: ForkVariant[] = ['fork', 'fork-and-rewind'];

/** A runner body carrying the new thread where the variant expects it. */
function bodyFor(variant: ForkVariant, thread: unknown): unknown {
  return variant === 'fork' ? thread : { thread, rewind: { commit: 'abc' } };
}

describe('forkThread use case', () => {
  test.each(VARIANTS)('%s runs resolve → remote → register → cache', async (variant) => {
    const f = fakes({ response: { ok: true, thread: bodyFor(variant, { id: 't-new' }) } });
    const result = await authorizedFork(f.ports)({ actor, variant, source, body: '{"a":1}' });
    expect(result._unsafeUnwrap()).toEqual({
      thread: bodyFor(variant, { id: 't-new' }),
      threadId: 't-new',
      runnerId: 'runner-1',
    } as any);
    expect(f.effects).toEqual(['resolve', 'remote', 'register', 'cache']);
    expect(f.resolveCalls).toEqual([{ actor, projectId: 'p1' }]);
    expect(f.remoteCalls).toEqual([
      { runnerId: 'runner-1', variant, sourceId: 't-source', body: '{"a":1}', projectId: 'p1' },
    ]);
    expect(f.cached).toEqual([['t-new', 'user-1', 'runner-1']]);
  });

  test('the raw body is handed to the remote port untouched', async () => {
    const f = fakes();
    const raw = '{ "messageId" : "m" ,\n "x":[1] }';
    await authorizedFork(f.ports)({ actor, variant: 'fork', source, body: raw });
    expect(f.remoteCalls[0].body).toBe(raw);
  });

  test('no runner → no-runner failure, and no remote call', async () => {
    const f = fakes({ runnerId: null });
    const result = await authorizedFork(f.ports)({ actor, variant: 'fork', source, body: '{}' });
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'no-runner',
      reason: 'general-runner-offline',
    });
    expect(f.effects).toEqual(['resolve']);
  });

  test('resolver exceptions propagate unchanged', async () => {
    const f = fakes({ resolveError: new Error('resolver down') });
    await expect(
      authorizedFork(f.ports)({ actor, variant: 'fork', source, body: '{}' }),
    ).rejects.toThrow('resolver down');
  });

  test('remote error is returned with its status and message, nothing registered', async () => {
    const f = fakes({ response: { ok: false, status: 409, message: 'Runner error: busy' } });
    const result = await authorizedFork(f.ports)({
      actor,
      variant: 'fork-and-rewind',
      source,
      body: '{}',
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'remote-error',
      status: 409,
      message: 'Runner error: busy',
    });
    expect(f.effects).toEqual(['resolve', 'remote']);
  });

  test.each([
    ['remote transport', { remoteError: new Error('boom') }, ['resolve', 'remote']],
    ['registry', { registerError: new Error('constraint') }, ['resolve', 'remote', 'register']],
    ['cache', { cacheError: new Error('cache') }, ['resolve', 'remote', 'register', 'cache']],
  ] as const)('%s exception → fork-failed with the cause', async (_name, opts, effects) => {
    const f = fakes(opts);
    const result = await authorizedFork(f.ports)({ actor, variant: 'fork', source, body: '{}' });
    const failure = result._unsafeUnwrapErr();
    expect(failure.kind).toBe('fork-failed');
    expect((failure as any).cause).toBeInstanceOf(Error);
    expect(f.effects).toEqual([...effects]);
  });

  describe('response extraction per variant', () => {
    test('fork reads the new thread at the top level', async () => {
      const f = fakes({ response: { ok: true, thread: { id: 't-top', title: 'Top' } } });
      const result = await authorizedFork(f.ports)({ actor, variant: 'fork', source, body: '{}' });
      expect(result._unsafeUnwrap().threadId).toBe('t-top' as any);
      expect(f.registrations[0].id).toBe('t-top' as any);
    });

    test('fork-and-rewind reads the new thread under `thread` and returns the whole body', async () => {
      const body = { thread: { id: 't-nested', title: 'Nested' }, rewind: { commit: 'abc' } };
      const f = fakes({ response: { ok: true, thread: body } });
      const result = await authorizedFork(f.ports)({
        actor,
        variant: 'fork-and-rewind',
        source,
        body: '{}',
      });
      expect(result._unsafeUnwrap()).toEqual({
        thread: body,
        threadId: 't-nested',
        runnerId: 'runner-1',
      } as any);
      expect(f.registrations[0]).toMatchObject({ id: 't-nested', title: 'Nested' });
    });

    test('fork-and-rewind ignores a top-level id (fork shape)', async () => {
      const f = fakes({ response: { ok: true, thread: { id: 't-top' } } });
      const result = await authorizedFork(f.ports)({
        actor,
        variant: 'fork-and-rewind',
        source,
        body: '{}',
      });
      expect(result._unsafeUnwrap().threadId).toBeUndefined();
      expect(f.effects).toEqual(['resolve', 'remote']);
    });

    test.each(VARIANTS)(
      '%s: a null body is returned and nothing is registered',
      async (variant) => {
        const f = fakes({ response: { ok: true, thread: null } });
        const result = await authorizedFork(f.ports)({ actor, variant, source, body: '{}' });
        expect(result._unsafeUnwrap()).toEqual({
          thread: null,
          threadId: undefined,
          runnerId: 'runner-1',
        } as any);
        expect(f.effects).toEqual(['resolve', 'remote']);
      },
    );

    test.each(VARIANTS)('%s: a missing id skips registration', async (variant) => {
      const f = fakes({ response: { ok: true, thread: bodyFor(variant, { title: 'no id' }) } });
      const result = await authorizedFork(f.ports)({ actor, variant, source, body: '{}' });
      expect(result._unsafeUnwrap().threadId).toBeUndefined();
      expect(f.effects).toEqual(['resolve', 'remote']);
    });
  });

  test('__default__ runner forks remotely but neither registers nor caches', async () => {
    const f = fakes({ runnerId: '__default__' });
    const result = await authorizedFork(f.ports)({ actor, variant: 'fork', source, body: '{}' });
    expect(result._unsafeUnwrap().runnerId).toBe('__default__' as any);
    expect(f.effects).toEqual(['resolve', 'remote']);
  });

  test.each(VARIANTS)(
    '%s: registration comes from the response, project from the source, isScratch false',
    async (variant) => {
      const f = fakes({
        response: {
          ok: true,
          thread: bodyFor(variant, {
            id: 't-new',
            title: 'RT title',
            model: 'opus',
            mode: 'worktree',
            branch: 'rt/branch',
          }),
        },
      });
      await authorizedFork(f.ports)({
        actor,
        variant,
        source,
        body: '{"title":"Body","model":"haiku","mode":"local","branch":"body/b"}',
      });
      expect(f.registrations).toEqual([
        {
          id: 't-new',
          projectId: 'p1',
          runnerId: 'runner-1',
          userId: 'user-1',
          title: 'RT title',
          model: 'opus',
          mode: 'worktree',
          branch: 'rt/branch',
          isScratch: false,
        } as any,
      ]);
    },
  );

  test('a null branch is registered as undefined, and a scratch source keeps its null project', async () => {
    const f = fakes({ response: { ok: true, thread: { id: 't-new', branch: null } } });
    await authorizedFork(f.ports)({
      actor,
      variant: 'fork',
      source: { id: authorizedThreadId('t-scratch'), projectId: null, ownerId: 'user-1' },
      body: '{}',
    });
    expect(f.resolveCalls[0].projectId).toBeNull();
    expect(f.registrations[0]).toMatchObject({ projectId: null, isScratch: false });
    expect(f.registrations[0].branch).toBeUndefined();
  });
});
