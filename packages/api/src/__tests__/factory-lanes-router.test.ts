import { describe, expect, test } from 'bun:test';

import type { Capability } from '@funny/shared/auth/roles';
import type { FactorySettings } from '@funny/shared/contracts/factory';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { errAsync, okAsync } from 'neverthrow';

import { failure, type FactoryPort } from '../index.js';
import { factoryRouter } from '../routers/factory.js';
import { portsWith, readTrpcBody } from './test-helpers.js';

function setup(opts: { capabilities?: Capability[]; factory?: Partial<FactoryPort> }) {
  const allowed = new Set<Capability>(opts.capabilities ?? ['view', 'steer']);
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const factoryPort: Partial<FactoryPort> = {
    settings: async (userId, projectId) => {
      calls.push({ method: 'settings', args: [userId, projectId] });
      return okAsync(null);
    },
    save: async (userId, projectId, input) => {
      calls.push({ method: 'save', args: [userId, projectId, input] });
      // SAFETY: the router returns what the port answers; the test reads only these fields.
      const saved = {
        projectId,
        enabled: input.enabled,
        laneLabelPrefix: input.laneLabelPrefix ?? 'feature:',
        laneBranchPrefix: input.laneBranchPrefix ?? 'feature/',
      } as FactorySettings;
      return okAsync(saved);
    },
    lanes: async (userId, projectId) => {
      calls.push({ method: 'lanes', args: [userId, projectId] });
      return okAsync([]);
    },
    removeLane: async (userId, projectId, name) => {
      calls.push({ method: 'removeLane', args: [userId, projectId, name] });
      return okAsync({ ok: true as const });
    },
    syncLane: async (userId, projectId, name) => {
      calls.push({ method: 'syncLane', args: [userId, projectId, name] });
      return okAsync({ outcome: 'requested' as const });
    },
    finishLane: async (userId, projectId, name) => {
      calls.push({ method: 'finishLane', args: [userId, projectId, name] });
      return okAsync({
        lane: name,
        branch: `feature/${name}`,
        base: 'main',
        prNumber: 42,
        prUrl: 'https://github.com/o/r/pull/42',
      });
    },
    ...opts.factory,
  };

  const ports = portsWith({
    authz: {
      projectAccess: async (capability, _projectId, _userId, forbidden) =>
        allowed.has(capability) ? null : failure(403, forbidden ?? 'Forbidden'),
      adminRefused: () => {},
    },
    factory: factoryPort as FactoryPort,
  });

  const call = async (path: string, input: unknown, method: 'GET' | 'POST' = 'POST') => {
    const qs = method === 'GET' ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      router: factoryRouter,
      req: new Request(`http://x/trpc/${path}${qs}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(input) : undefined,
      }),
      createContext: () => ({ userId: 'alice', userRole: 'user', organizationId: null, ports }),
    });
    return { status: res.status, body: await readTrpcBody(res) };
  };

  return { call, calls };
}

describe('factory lanes router', () => {
  test('settings save forwards lane prefixes and requires steer', async () => {
    const viewer = setup({ capabilities: ['view'] });
    const denied = await viewer.call('save', {
      projectId: 'p1',
      enabled: true,
      laneLabelPrefix: 'lane:',
      laneBranchPrefix: 'lane/',
    });
    expect(denied.status).toBe(403);
    expect(viewer.calls).toHaveLength(0);

    const steerer = setup({ capabilities: ['view', 'steer'] });
    const saved = await steerer.call('save', {
      projectId: 'p1',
      enabled: true,
      laneLabelPrefix: 'lane:',
      laneBranchPrefix: 'lane/',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.result?.data).toMatchObject({
      laneLabelPrefix: 'lane:',
      laneBranchPrefix: 'lane/',
    });
  });

  test('lanes.list allows view; remove, sync and finish answer 403 without steer', async () => {
    const viewer = setup({ capabilities: ['view'] });

    const listed = await viewer.call('lanes.list', { projectId: 'p1' }, 'GET');
    expect(listed.status).toBe(200);
    expect(listed.body.result?.data).toEqual([]);

    for (const procedure of ['lanes.remove', 'lanes.sync', 'lanes.finish']) {
      const res = await viewer.call(procedure, { projectId: 'p1', name: 'auth' });
      expect(res.status).toBe(403);
    }
    expect(viewer.calls.map((c) => c.method)).toEqual(['lanes']);
  });

  test('lanes.remove, lanes.sync and lanes.finish answer 404 for another user factory', async () => {
    const { call } = setup({
      capabilities: ['view', 'steer'],
      factory: {
        removeLane: async () => errAsync(failure(404, 'Lane not found')),
        syncLane: async () => errAsync(failure(404, 'Lane not found')),
        finishLane: async () => errAsync(failure(404, 'Lane not found')),
      },
    });

    for (const procedure of ['lanes.remove', 'lanes.sync', 'lanes.finish']) {
      const res = await call(procedure, { projectId: 'p1', name: 'auth' });
      expect(res.status).toBe(404);
    }
  });

  test('lanes.remove, lanes.sync and lanes.finish forward to the port with steer', async () => {
    const { call, calls } = setup({ capabilities: ['view', 'steer'] });

    expect((await call('lanes.remove', { projectId: 'p1', name: 'auth' })).status).toBe(200);
    expect((await call('lanes.sync', { projectId: 'p1', name: 'auth' })).body.result?.data).toEqual(
      {
        outcome: 'requested',
      },
    );
    expect(
      (await call('lanes.finish', { projectId: 'p1', name: 'auth' })).body.result?.data,
    ).toMatchObject({
      lane: 'auth',
      prNumber: 42,
    });
    expect(calls.map((c) => c.method)).toEqual(['removeLane', 'syncLane', 'finishLane']);
  });
});
