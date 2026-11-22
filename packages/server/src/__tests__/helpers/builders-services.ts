/**
 * Typed fixtures and test doubles for the server service tests
 * (`__tests__/services/**`), so the tests do not need type assertions.
 */
import { readFileSync } from 'node:fs';

import type { WSEvent } from '@funny/shared';
import type { StartAgentPayload } from '@funny/shared/runner-protocol';
import { SANDBOX_STATES, type SandboxState } from '@funny/shared/sandbox-machine';
import { err, ok, type Result } from 'neverthrow';
import type { Server as SocketIOServer } from 'socket.io';

import type { FactoryFlowRunsDeps } from '../../services/factory/factory-flow-runs.js';
import type {
  RunnerPorts,
  StartThreadError,
  StartedThread,
} from '../../services/runner-thread-launcher.js';
import type { ThreadSandboxRow } from '../../services/thread-sandboxes/thread-sandbox-store.js';
import { FakeRunnerRequestPort } from './runner-port-fakes.js';

/**
 * `value`, checked to be an instance of `type` (instead of a cast to it).
 * Throws when it is not, so a wrong guess fails the test.
 */
export function expectInstance<V, T>(value: V, type: abstract new (...args: never[]) => T): V & T {
  if (!(value instanceof type)) {
    throw new Error(`expected an instance of ${type.name}`);
  }
  return value;
}

// ── Thread launcher doubles ─────────────────────────────────────

/** What a launcher answers. */
export type LaunchResult = Result<StartedThread, StartThreadError>;

/** A successful launch of thread `threadId` on runner `runnerId`. */
export function launchedThread(threadId: string, runnerId = 'r1'): LaunchResult {
  return ok({ thread: { id: threadId }, threadId, runnerId });
}

/** A launch refused because the owner's runner is offline. */
export function runnerOffline(message: string): LaunchResult {
  return err({ kind: 'runner-unavailable', status: 502, message });
}

/** Runner ports for code whose launcher is faked: no request ever reaches them. */
export function unusedRunnerPorts(): RunnerPorts {
  return { requests: new FakeRunnerRequestPort() };
}

// ── fetch ───────────────────────────────────────────────────────

/** A fake `fetch` answering every request with `handler(url, init)`. */
export function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit) =>
      handler(input instanceof Request ? input.url : String(input), init),
    { preconnect: fetch.preconnect },
  );
}

// ── Thread sandboxes ────────────────────────────────────────────

/** A stored sandbox state, checked against the machine's states. */
export function sandboxStateOf(value: string): SandboxState {
  const state = SANDBOX_STATES.find((candidate) => candidate === value);
  if (!state) throw new Error(`not a sandbox state: ${value}`);
  return state;
}

/** A `thread_sandboxes` row with a default for every column. */
export function buildThreadSandboxRow(overrides: Partial<ThreadSandboxRow> = {}): ThreadSandboxRow {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    threadId: 't-1',
    userId: 'user-1',
    connectionId: 'conn-1',
    provider: 'fake',
    sandboxId: null,
    runnerId: null,
    sizeId: 'default',
    repoUrl: null,
    llmTokenHash: null,
    runnerLink: null,
    state: 'running',
    error: null,
    generation: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** `value`, which the test expects to be there (a row, a call); throws when it is not. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

// ── Runner tasks ────────────────────────────────────────────────

/** A `start_agent` runner task payload with a default for every required field. */
export function buildStartAgentPayload(
  overrides: Partial<StartAgentPayload> = {},
): StartAgentPayload {
  return {
    type: 'start_agent',
    prompt: 'Do the task',
    cwd: '/tmp/repo',
    model: 'sonnet',
    provider: 'claude',
    permissionMode: 'autoEdit',
    ...overrides,
  };
}

/** A runner request body as text (the tests send JSON strings). */
export function bodyText(body: string | Uint8Array | null | undefined): string {
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return body ?? '';
}

// ── Socket.IO ───────────────────────────────────────────────────

/** The parts of a Socket.IO namespace the browser event tests fake. */
export interface FakeNamespace {
  readonly sockets: { readonly size: number };
  readonly adapter: { readonly rooms: ReadonlyMap<string, ReadonlySet<unknown>> };
  readonly emit?: (event: string) => void;
  readonly to?: (room: string) => { emit: (event: string) => void };
}

/** A Socket.IO server whose every namespace is `namespace`. */
export function serverWithNamespace(namespace: FakeNamespace): SocketIOServer {
  // SAFETY: the browser event sink and `setIO` only call `io.of(name)` and read the
  // members each test's namespace provides (sockets, adapter.rooms, emit, to).
  return { of: () => namespace } as any;
}

// ── Runner events ───────────────────────────────────────────────

/**
 * A runner event of `type` carrying a marker `data` the test recognises,
 * not a real payload of that type.
 */
export function markerEvent(
  type: WSEvent['type'],
  threadId: string,
  data: Record<string, string>,
): WSEvent {
  // SAFETY: the gRPC transport and the server's event relay pass `data` through
  // without reading it for these event types; the tests assert it arrives unchanged.
  return { type, threadId, data } as any;
}

/**
 * A reviewer that passes the fakes' head commit (`sha-head`): a reviewer's
 * thread (the fake launchers name them `rev-N`) says pass; any other thread
 * says what is stored for it.
 */
export async function passingReview(threadId: string): Promise<string | null> {
  if (threadId.startsWith('rev-')) {
    return ['```json', JSON.stringify({ sha: 'sha-head', verdict: 'pass' }), '```'].join('\n');
  }
  // Imported here: this module is loaded by tests that never open a database.
  const { lastThreadMessage } = await import('../../services/factory/factory-thread-waits.js');
  return lastThreadMessage(threadId);
}

/** A runner proof service whose every regression proof passes at once. */
export const passingProof: NonNullable<FactoryFlowRunsDeps['proof']> = () => ({
  startProof: async () => ok({ proofId: 'proof-1', state: 'done' }),
  pollProof: async () =>
    ok({
      state: 'done',
      result: {
        verdict: 'pass',
        headSha: 'sha-head',
        files: [],
        commands: [],
        baseSha: 'abc',
        outputTail: '',
      },
    }),
});

/**
 * The built-in `issue-to-merge` flow as a repository copy with one proof rule,
 * so it is proof-ready and its merge step may merge (the built-in has no rules).
 */
export function proofReadyFlowFiles(): Record<string, string> {
  const builtIn = readFileSync(
    new URL('../../../../workflows/defaults/issue-to-merge.yaml', import.meta.url),
    'utf8',
  );
  const withRule = builtIn.replace(
    '    regression_proof:\n',
    "    regression_proof:\n      rules:\n        - globs: ['**/*.test.ts']\n          command: 'bun test {{files}}'\n",
  );
  if (withRule === builtIn) throw new Error('issue-to-merge.yaml has no regression_proof step');
  return { '.funny/workflows/issue-to-merge.yaml': withRule };
}
