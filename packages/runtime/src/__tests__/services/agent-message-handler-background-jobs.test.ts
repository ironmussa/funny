import { afterEach, describe, expect, test, vi } from 'bun:test';

import type { CLIMessage } from '@funny/core/agents';

import { AgentMessageHandler } from '../../services/agent-message-handler.js';
import { AgentStateTracker } from '../../services/agent-state.js';
import { resetServices, setServices } from '../../services/service-registry.js';
import {
  buildThreadRecord,
  createServiceProviderFake,
  createThreadManagerFake,
} from '../helpers/builders.js';

const THREAD_ID = 'thread-bg-job';

afterEach(() => resetServices());

function makeHandler() {
  const state = new AgentStateTracker();
  state.threadUserIds.set(THREAD_ID, 'user-1');
  const emitted: Array<{ type: string; data: any }> = [];
  const wsBroker = {
    emit: vi.fn(),
    emitToUser: vi.fn((_userId: string, event: any) => {
      emitted.push({ type: event.type, data: event.data });
    }),
  };
  const threadManager = createThreadManagerFake({
    getThread: vi.fn(async () =>
      buildThreadRecord({
        id: THREAD_ID,
        userId: 'user-1',
        projectId: 'proj-1',
        status: 'running',
      }),
    ),
    updateThread: vi.fn(async () => undefined),
  });
  const handler = new AgentMessageHandler(state, threadManager, wsBroker, () => undefined);
  return { handler, emitted };
}

function withRunningJobs(threadIds: string[]) {
  setServices(
    createServiceProviderFake({
      jobs: {
        listRunningJobs: vi.fn(
          async () => threadIds.map((threadId, i) => ({ id: `job-${i}`, threadId })) as any,
        ),
      },
    }),
  );
}

const successResult: CLIMessage = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 10,
  num_turns: 1,
  result: 'started the job',
  total_cost_usd: 0.01,
  session_id: 'sess-1',
};

describe('AgentMessageHandler — turn ends with a background job running', () => {
  test('marks the result so clients do not announce the run as finished', async () => {
    withRunningJobs([THREAD_ID]);
    const { handler, emitted } = makeHandler();

    await handler.handle(THREAD_ID, successResult);

    const result = emitted.find((e) => e.type === 'agent:result');
    expect(result?.data.status).toBe('completed');
    expect(result?.data.backgroundJobPending).toBe(true);
  });

  test('leaves the result unmarked when only another thread has a running job', async () => {
    withRunningJobs(['other-thread']);
    const { handler, emitted } = makeHandler();

    await handler.handle(THREAD_ID, successResult);

    const result = emitted.find((e) => e.type === 'agent:result');
    expect(result?.data.status).toBe('completed');
    expect(result?.data.backgroundJobPending).toBeUndefined();
  });
});
