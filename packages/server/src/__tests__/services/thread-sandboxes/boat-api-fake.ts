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

  const fakeFetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, headers, body });

    if (queued.length) return queued.shift()!();
    if (headers.authorization !== `Bearer ${validKey}`) return error(401, 'unauthorized');

    if (method === 'GET' && path === '/limits') {
      return json(200, {
        ok: true,
        type: 'limits.info',
        accessTier: 'standard',
        blockedReason: null,
      });
    }
    if (method === 'GET' && path === '/saved-snapshots') {
      return json(200, {
        ok: true,
        savedSnapshots: [...savedSnapshots].map((name) => ({ name, status: 'ready' })),
      });
    }
    if (method === 'POST' && path === '/saved-snapshots') {
      if (!sandboxes.has(body?.sandboxId)) return error(404, 'not_found');
      savingPolls.set(body.name, 1);
      return json(202, {
        ok: true,
        type: 'snapshot.saved.saving',
        status: 'saving',
        snapshot: { name: body.name, status: 'saving' },
      });
    }
    const snapshot = path.match(/^\/saved-snapshots\/(.+)$/);
    if (snapshot) {
      const name = decodeURIComponent(snapshot[1]);
      if (method === 'DELETE') {
        if (!savedSnapshots.delete(name)) return error(404, 'snapshot_not_found');
        return json(200, { ok: true });
      }
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
    }
    if (method === 'POST' && path === '/sandboxes') {
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
    }
    const one = path.match(/^\/sandboxes\/([^/]+)(\/(stop|resume))?$/);
    if (one) {
      const sandbox = sandboxes.get(one[1]);
      if (!sandbox) return error(404, 'not_found');
      const action = one[3];
      if (method === 'GET') return json(200, { ok: true, sandbox });
      if (method === 'POST' && action === 'stop') {
        sandbox.state = 'archived';
        return json(200, { ok: true, type: 'sandbox.stopping', id: sandbox.id });
      }
      if (method === 'POST' && action === 'resume') {
        if (sandbox.dataExpiredAt) return error(409, 'snapshot_data_expired');
        sandbox.state = 'ready';
        sandbox.ttlSeconds = body?.ttlSeconds ?? sandbox.ttlSeconds;
        return json(200, { ok: true, type: 'sandbox.resuming', sandbox });
      }
      if (method === 'PATCH') {
        sandbox.ttlSeconds = body?.ttlSeconds ?? null;
        return json(200, { ok: true, sandbox });
      }
      if (method === 'DELETE') {
        if (headers['x-ascii-confirm-delete'] !== sandbox.id) return error(400, 'confirm_required');
        sandboxes.delete(sandbox.id);
        return json(202, { ok: true, type: 'sandbox.deleting' });
      }
    }
    const commandPath = path.match(/^\/sandboxes\/([^/]+)\/commands$/);
    if (method === 'POST' && commandPath) {
      const sandbox = sandboxes.get(commandPath[1]);
      if (!sandbox) return error(404, 'not_found');
      if (sandbox.state !== 'ready') return error(409, 'machine_not_running');
      commands.push({ sandboxId: sandbox.id, command: body?.command ?? '' });
      const exitCode = nextExitCode ?? 0;
      nextExitCode = undefined;
      return json(200, { ok: true, exitCode, stdout: 'ok', stderr: exitCode ? 'boom' : '' });
    }
    return error(400, 'unsupported_in_fake');
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
