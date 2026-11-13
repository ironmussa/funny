/**
 * In-memory emulation of the Boat REST API subset the adapter uses. Response
 * envelopes follow what the real API returned in the thread-sandboxes spike
 * (`{ ok, type, sandbox: { id, state, … } }`, error `{ ok:false, code, message }`).
 */

interface FakeSandbox {
  id: string;
  state: string;
  dataExpiredAt: string | null;
  ttlSeconds: number | null;
  body: any;
}

export interface BoatApiFake {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: any }>;
  sandboxes: Map<string, FakeSandbox>;
  savedSnapshots: Set<string>;
  commands: Array<{ sandboxId: string; command: string }>;
  failNextCommand(exitCode: number): void;
  expire(sandboxId: string): void;
  respondOnce(status: number, body: any, headers?: Record<string, string>): void;
}

const json = (status: number, body: any, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const error = (status: number, code: string, message = code) =>
  json(status, { ok: false, type: 'sandbox.error', status, code, message });

export function createBoatApiFake(validKey = 'boat_test_key'): BoatApiFake {
  const sandboxes = new Map<string, FakeSandbox>();
  const savedSnapshots = new Set<string>(['funny-runner-0.0.0-test']);
  const savingPolls = new Map<string, number>();
  const commands: Array<{ sandboxId: string; command: string }> = [];
  let nextExitCode: number | undefined;
  const byIdempotencyKey = new Map<string, string>();
  const requests: BoatApiFake['requests'] = [];
  const queued: Array<() => Response> = [];
  let counter = 0;

  interface FakeRequest {
    method: string;
    headers: Record<string, string>;
    body: any;
    match: RegExpMatchArray;
  }
  type Handler = (req: FakeRequest) => Response | undefined;

  const getSnapshot = (name: string) => {
    const remaining = savingPolls.get(name);
    if (remaining !== undefined) {
      // One poll in `saving`, then the snapshot becomes ready.
      if (remaining > 0) {
        savingPolls.set(name, remaining - 1);
        return json(200, { ok: true, snapshot: { name, status: 'saving' } });
      }
      savingPolls.delete(name);
      savedSnapshots.add(name);
    }
    return savedSnapshots.has(name)
      ? json(200, { ok: true, snapshot: { name, status: 'ready' } })
      : error(404, 'snapshot_not_found');
  };

  const createSandbox: Handler = ({ headers, body }) => {
    const key = headers['idempotency-key'];
    const existing = key ? byIdempotencyKey.get(key) : undefined;
    if (existing)
      return json(200, { ok: true, type: 'sandbox.created', sandbox: sandboxes.get(existing) });
    const id = `bx_fake${++counter}`;
    sandboxes.set(id, {
      id,
      state: 'ready',
      dataExpiredAt: null,
      ttlSeconds: body?.ttlSeconds ?? null,
      body,
    });
    if (key) byIdempotencyKey.set(key, id);
    return json(201, { ok: true, type: 'sandbox.created', sandbox: sandboxes.get(id) });
  };

  /** Per-sandbox actions, keyed by `METHOD action` (empty action for the sandbox itself). */
  const sandboxActions: Record<
    string,
    (sandbox: FakeSandbox, req: FakeRequest) => Response | undefined
  > = {
    'GET ': (sandbox) => json(200, { ok: true, sandbox }),
    'POST stop': (sandbox) => {
      sandbox.state = 'archived';
      return json(200, { ok: true, type: 'sandbox.stopping', id: sandbox.id });
    },
    'POST resume': (sandbox, { body }) => {
      if (sandbox.dataExpiredAt) return error(409, 'snapshot_data_expired');
      sandbox.state = 'ready';
      sandbox.ttlSeconds = body?.ttlSeconds ?? sandbox.ttlSeconds;
      return json(200, { ok: true, type: 'sandbox.resuming', sandbox });
    },
    'POST host': (sandbox, { body }) => {
      if (sandbox.state !== 'ready') return error(409, 'machine_not_running');
      const url = `https://${sandbox.id}-${body?.port}.on.boat.test`;
      return json(200, {
        ok: true,
        type: 'port.hosted',
        port: body?.port,
        url: body?.public ? url : `${url}?_token=tok_${sandbox.id}`,
        access: body?.public ? 'public' : 'private',
      });
    },
    'PATCH ': (sandbox, { body }) => {
      sandbox.ttlSeconds = body?.ttlSeconds ?? null;
      return json(200, { ok: true, sandbox });
    },
    'DELETE ': (sandbox, { headers }) => {
      if (headers['x-ascii-confirm-delete'] !== sandbox.id) return error(400, 'confirm_required');
      sandboxes.delete(sandbox.id);
      return json(202, { ok: true, type: 'sandbox.deleting' });
    },
  };

  const sandboxRoute: Handler = (req) => {
    const sandbox = sandboxes.get(req.match[1]);
    if (!sandbox) return error(404, 'not_found');
    // GET / PATCH / DELETE ignore a trailing action; POST needs one.
    const action =
      sandboxActions[`${req.method} ${req.match[3] ?? ''}`] ?? sandboxActions[`${req.method} `];
    return action?.(sandbox, req);
  };

  const runCommand: Handler = ({ method, body, match }) => {
    if (method !== 'POST') return undefined;
    const sandbox = sandboxes.get(match[1]);
    if (!sandbox) return error(404, 'not_found');
    if (sandbox.state !== 'ready') return error(409, 'machine_not_running');
    commands.push({ sandboxId: sandbox.id, command: body?.command ?? '' });
    const exitCode = nextExitCode ?? 0;
    nextExitCode = undefined;
    return json(200, { ok: true, exitCode, stdout: 'ok', stderr: exitCode ? 'boom' : '' });
  };

  /**
   * Routes in match order; a handler returning `undefined` falls through to the
   * next route (and finally to `unsupported_in_fake`).
   */
  const routes: Array<{ method?: string; path: RegExp; handle: Handler }> = [
    {
      method: 'GET',
      path: /^\/limits$/,
      handle: () =>
        json(200, { ok: true, type: 'limits.info', accessTier: 'standard', blockedReason: null }),
    },
    {
      method: 'GET',
      path: /^\/saved-snapshots$/,
      handle: () =>
        json(200, {
          ok: true,
          savedSnapshots: [...savedSnapshots].map((name) => ({ name, status: 'ready' })),
        }),
    },
    {
      method: 'POST',
      path: /^\/saved-snapshots$/,
      handle: ({ body }) => {
        if (!sandboxes.has(body?.sandboxId)) return error(404, 'not_found');
        savingPolls.set(body.name, 1);
        return json(202, {
          ok: true,
          type: 'snapshot.saved.saving',
          status: 'saving',
          snapshot: { name: body.name, status: 'saving' },
        });
      },
    },
    {
      path: /^\/saved-snapshots\/(.+)$/,
      handle: ({ method, match }) => {
        const name = decodeURIComponent(match[1]);
        if (method !== 'DELETE') return getSnapshot(name);
        if (!savedSnapshots.delete(name)) return error(404, 'snapshot_not_found');
        return json(200, { ok: true });
      },
    },
    { method: 'POST', path: /^\/sandboxes$/, handle: createSandbox },
    { path: /^\/sandboxes\/([^/]+)(\/(stop|resume|host))?$/, handle: sandboxRoute },
    { path: /^\/sandboxes\/([^/]+)\/commands$/, handle: runCommand },
  ];

  const route = (method: string, path: string, headers: Record<string, string>, body: any) => {
    for (const r of routes) {
      if (r.method && r.method !== method) continue;
      const match = path.match(r.path);
      const response = match ? r.handle({ method, headers, body, match }) : undefined;
      if (response) return response;
    }
    return error(400, 'unsupported_in_fake');
  };

  const fakeFetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, headers, body });

    if (queued.length) return queued.shift()!();
    if (headers.authorization !== `Bearer ${validKey}`) return error(401, 'unauthorized');
    return route(method, path, headers, body);
  };

  return {
    fetch: fakeFetch,
    requests,
    sandboxes,
    savedSnapshots,
    commands,
    failNextCommand: (exitCode) => {
      nextExitCode = exitCode;
    },
    expire: (sandboxId) => {
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox) sandbox.dataExpiredAt = '2026-01-01T00:00:00Z';
    },
    respondOnce: (status, body, headers) => queued.push(() => json(status, body, headers)),
  };
}
