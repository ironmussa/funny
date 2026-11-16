/**
 * In-memory emulation of the InstaBox REST API subset the adapter uses, shaped
 * after https://api.instabox.sh/v1/openapi.json: lifecycle calls answer an
 * operation (`{ id, type, state, machineId }`) and apply at once; errors are
 * `{ error: { code, message, retryable, retryAfterSeconds? } }`.
 */

interface FakeMachine {
  id: string;
  state: string;
  ready: boolean;
  synced: boolean;
  body: any;
}

interface FakeSnapshot {
  id: string;
  name: string;
  status: 'pending' | 'ready' | 'failed';
}

export interface InstaboxApiFake {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: any }>;
  machines: Map<string, FakeMachine>;
  snapshots: Map<string, FakeSnapshot>;
  commands: Array<{ machineId: string; cmd: string }>;
  failNextCommand(exitCode: number): void;
  respondOnce(status: number, body: any, headers?: Record<string, string>): void;
}

const json = (status: number, body: any, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const error = (status: number, code: string, message = code, retryable = false) =>
  json(status, { error: { code, message, retryable } });

export const KNOWN_TEMPLATE_SNAPSHOT_ID = 'sn_known';

export function createInstaboxApiFake(validKey = 'ibk_test_key'): InstaboxApiFake {
  const machines = new Map<string, FakeMachine>();
  const snapshots = new Map<string, FakeSnapshot>([
    [
      KNOWN_TEMPLATE_SNAPSHOT_ID,
      { id: KNOWN_TEMPLATE_SNAPSHOT_ID, name: 'funny-runner-0-0-0-test', status: 'ready' },
    ],
  ]);
  const commands: InstaboxApiFake['commands'] = [];
  const byIdempotencyKey = new Map<string, string>();
  const requests: InstaboxApiFake['requests'] = [];
  const queued: Array<() => Response> = [];
  const pendingPolls = new Map<string, number>();
  let nextExitCode: number | undefined;
  let counter = 0;

  const operation = (type: string, machineId: string) =>
    json(202, { id: `op_${++counter}`, type, state: 'succeeded', machineId });

  const createMachine = (headers: Record<string, string>, body: any) => {
    const key = headers['idempotency-key'];
    if (!key) return error(400, 'bad_request', 'missing Idempotency-Key');
    const existing = byIdempotencyKey.get(key);
    if (existing) return operation('create', existing);
    if (body?.snapshotId && !snapshots.has(body.snapshotId)) return error(404, 'not_found');
    const id = `m_fake${++counter}`;
    machines.set(id, { id, state: 'running', ready: true, synced: true, body });
    byIdempotencyKey.set(key, id);
    return operation('create', id);
  };

  /** Per-machine actions, keyed by `METHOD action` (empty action for the machine itself). */
  const machineActions: Record<
    string,
    (machine: FakeMachine, headers: Record<string, string>, body: any) => Response
  > = {
    'GET ': (m) =>
      json(200, {
        id: m.id,
        state: m.state,
        runtime: { ready: m.ready },
        storage: { synced: m.synced },
      }),
    'POST stop': (m) => {
      if (m.state === 'suspended') return error(409, 'operation_conflict', 'paused');
      m.state = 'stopped';
      return operation('stop', m.id);
    },
    'POST start': (m) => {
      m.state = 'running';
      return operation('start', m.id);
    },
    'POST exec': (m, _headers, body) => {
      if (m.state !== 'running') return error(409, 'machine_not_running', 'not running', true);
      commands.push({ machineId: m.id, cmd: body?.cmd ?? '' });
      const exitCode = nextExitCode ?? 0;
      nextExitCode = undefined;
      return json(200, { exitCode, stdout: 'ok', stderr: exitCode ? 'boom' : '' });
    },
    'POST ports': (m, _headers, { port, access = 'public', rotateToken = false }) => {
      const issued = access === 'private' && rotateToken;
      return json(201, {
        id: `pp_${++counter}`,
        machineId: m.id,
        port,
        url: `https://${port}-${m.id.slice(2)}.instabox.test`,
        access,
        ...(issued ? { token: `ibp_${counter}` } : {}),
      });
    },
    'POST snapshots': (m, _headers, body) => {
      if (m.state !== 'stopped') return error(409, 'operation_conflict', 'not stopped');
      const id = `sn_fake${++counter}`;
      snapshots.set(id, { id, name: body.name, status: 'pending' });
      pendingPolls.set(id, 1);
      return json(202, snapshots.get(id));
    },
    'DELETE ': (m, headers) => {
      if (headers['x-confirm-delete'] !== m.id) return error(409, 'delete_confirmation_required');
      machines.delete(m.id);
      return operation('delete', m.id);
    },
  };

  const getSnapshot = (id: string) => {
    const snapshot = snapshots.get(id);
    if (!snapshot) return error(404, 'not_found');
    const remaining = pendingPolls.get(id);
    if (remaining !== undefined) {
      // One poll in `pending`, then the snapshot becomes ready.
      if (remaining > 0) pendingPolls.set(id, remaining - 1);
      else {
        pendingPolls.delete(id);
        snapshot.status = 'ready';
      }
    }
    return json(200, snapshot);
  };

  interface FakeRequest {
    method: string;
    headers: Record<string, string>;
    body: any;
    match: RegExpMatchArray;
  }
  type Handler = (req: FakeRequest) => Response | undefined;

  const snapshotRoute: Handler = ({ method, headers, match }) => {
    const id = decodeURIComponent(match[1]);
    if (method === 'GET') return getSnapshot(id);
    if (method !== 'DELETE') return undefined;
    if (headers['x-confirm-delete'] !== id) return error(409, 'delete_confirmation_required');
    return snapshots.delete(id) ? json(204, null) : error(404, 'not_found');
  };

  const machineRoute: Handler = ({ method, headers, body, match }) => {
    const machine = machines.get(decodeURIComponent(match[1]));
    if (!machine) return error(404, 'not_found');
    // Every lifecycle POST needs an Idempotency-Key; exec is not idempotent.
    if (method === 'POST' && match[2] !== 'exec' && !headers['idempotency-key']) {
      return error(400, 'bad_request', 'missing Idempotency-Key');
    }
    return machineActions[`${method} ${match[2] ?? ''}`]?.(machine, headers, body);
  };

  /** Routes in match order; a handler returning `undefined` falls through. */
  const routes: Array<{ method?: string; path: RegExp; handle: Handler }> = [
    {
      method: 'GET',
      path: /^\/v1\/me$/,
      handle: () => json(200, { login: 'funny-dev', activated: true, inviteRequired: false }),
    },
    {
      method: 'POST',
      path: /^\/v1\/machines$/,
      handle: ({ headers, body }) => createMachine(headers, body),
    },
    {
      method: 'GET',
      path: /^\/v1\/snapshots$/,
      handle: () => json(200, { snapshots: [...snapshots.values()] }),
    },
    { path: /^\/v1\/snapshots\/([^/]+)$/, handle: snapshotRoute },
    { path: /^\/v1\/machines\/([^/]+)(?:\/([a-z]+))?$/, handle: machineRoute },
  ];

  const route = (method: string, path: string, headers: Record<string, string>, body: any) => {
    for (const r of routes) {
      if (r.method && r.method !== method) continue;
      const match = path.match(r.path);
      const response = match ? r.handle({ method, headers, body, match }) : undefined;
      if (response) return response;
    }
    return undefined;
  };

  const fakeFetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = url.pathname;
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, headers, body });

    if (queued.length) return queued.shift()!();
    if (headers['x-api-key'] !== validKey) return error(401, 'invalid_key', 'invalid API key');
    return route(method, path, headers, body) ?? error(400, 'unsupported_in_fake');
  };

  return {
    fetch: fakeFetch,
    requests,
    machines,
    snapshots,
    commands,
    failNextCommand: (exitCode) => {
      nextExitCode = exitCode;
    },
    respondOnce: (status, body, headers) => queued.push(() => json(status, body, headers)),
  };
}
