import { describe, expect, test } from 'bun:test';

import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { err, ok } from 'neverthrow';

import {
  appRouter,
  failure,
  failureFromDomainError,
  type ApiPorts,
  type AutomationsPort,
} from '../index.js';

const automation = {
  id: 'a1',
  projectId: 'p1',
  userId: 'u1',
  name: 'Job',
  prompt: 'p',
  schedule: '0 * * * *',
  provider: 'claude',
  model: 'sonnet',
  mode: 'local',
  permissionMode: 'autoEdit',
  enabled: true,
  maxRunHistory: 20,
  source: 'user',
  createdAt: 'now',
  updatedAt: 'now',
} as const;

function portsWith(overrides: Partial<AutomationsPort>): ApiPorts {
  const missing = async () => err(failure(500, 'not stubbed'));
  return {
    automations: {
      inbox: missing,
      list: missing,
      get: missing,
      create: missing,
      update: missing,
      remove: missing,
      trigger: missing,
      runs: missing,
      triageRun: missing,
      ...overrides,
    },
  } as ApiPorts;
}

async function call(
  ports: ApiPorts,
  path: string,
  init: { method?: string; input?: unknown; userId?: string | null } = {},
) {
  const method = init.method ?? 'GET';
  const query =
    method === 'GET' && init.input !== undefined
      ? `?input=${encodeURIComponent(JSON.stringify(init.input))}`
      : '';
  const res = await fetchRequestHandler({
    endpoint: '/api/trpc',
    router: appRouter,
    req: new Request(`http://x/api/trpc/${path}${query}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(init.input) : undefined,
    }),
    createContext: () => ({
      userId: init.userId === undefined ? 'u1' : init.userId,
      organizationId: null,
      userRole: 'user',
      ports,
    }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('procedure errors', () => {
  test('a request without a user is refused 401 before the handler runs', async () => {
    let ran = false;
    const ports = portsWith({
      list: async () => {
        ran = true;
        return ok([]);
      },
    });
    const res = await call(ports, 'automations.list', { userId: null });
    expect(res.status).toBe(401);
    expect(ran).toBe(false);
  });

  test('invalid input answers 400 with the first issue, and the handler does not run', async () => {
    let ran = false;
    const ports = portsWith({
      create: async () => {
        ran = true;
        return ok(automation as any);
      },
    });
    const res = await call(ports, 'automations.create', {
      method: 'POST',
      input: { projectId: 'p1', name: '', prompt: 'x', schedule: '* * * * *' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      'Missing required fields: projectId, name, prompt, schedule',
    );
    expect(ran).toBe(false);
  });

  test.each([
    [404, 'NOT_FOUND'],
    [403, 'FORBIDDEN'],
    [409, 'CONFLICT'],
    [502, 'BAD_GATEWAY'],
    [422, 'UNPROCESSABLE_CONTENT'],
    [418, 'BAD_REQUEST'],
  ])('a port failure with status %d answers that status (%s)', async (status, code) => {
    const ports = portsWith({ get: async () => err(failure(status, 'nope')) });
    const res = await call(ports, 'automations.get', { input: { id: 'a1' } });
    expect(res.status).toBe(status === 418 ? 400 : status);
    expect(res.body.error.message).toBe('nope');
    expect(res.body.error.data.code).toBe(code);
  });

  test('a friendly message reaches the client', async () => {
    const ports = portsWith({
      trigger: async () => err(failure(502, 'runner offline', 'Your runner is offline')),
    });
    const res = await call(ports, 'automations.trigger', { method: 'POST', input: { id: 'a1' } });
    expect(res.status).toBe(502);
    expect(res.body.error.friendlyMessage).toBe('Your runner is offline');
  });

  test('an unexpected throw is sanitized: no message details, no stack', async () => {
    const ports = portsWith({
      list: async () => {
        throw new Error('SELECT * FROM secrets failed at /srv/db.ts:42');
      },
    });
    const res = await call(ports, 'automations.list');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain('secrets');
    expect(res.body.error.data.stack).toBeUndefined();
  });

  test('success returns the port value', async () => {
    const ports = portsWith({ list: async () => ok([automation as any]) });
    const res = await call(ports, 'automations.list', { input: { projectId: 'p1' } });
    expect(res.status).toBe(200);
    expect(res.body.result.data).toEqual([automation]);
  });
});

describe('failureFromDomainError', () => {
  test.each([
    ['NOT_FOUND', 404],
    ['BAD_REQUEST', 400],
    ['VALIDATION', 400],
    ['FORBIDDEN', 403],
    ['CONFLICT', 409],
    ['PROCESS_ERROR', 500],
    ['INTERNAL', 500],
  ] as const)('%s → %d', (type, status) => {
    expect(failureFromDomainError({ type, message: 'm' } as any)).toEqual({ status, message: 'm' });
  });
});
