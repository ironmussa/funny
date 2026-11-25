/**
 * The factory tools of the `funny` MCP server (openspec factory-agent-tools):
 * what they send, that the thread comes from the grant and never from the
 * model, and that a server refusal is a tool error the agent can read.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { describeRun, factoryToolDefinitions } from '../../services/agent-factory-tools.js';

const request = vi.fn();
const THREAD = 'thread-1';

const tool = (name: string) => {
  const found = factoryToolDefinitions({ threadId: THREAD, userId: 'alice' }, request).find(
    (definition) => definition.name === name,
  );
  if (!found) throw new Error(`${name} is not registered`);
  return async (args: Record<string, unknown>) => {
    const result = await found.run(args, undefined);
    const [first] = result.content;
    return { isError: result.isError, text: first.type === 'text' ? first.text : '' };
  };
};

const held = {
  id: 'run-1',
  issueNumber: 451,
  prUrl: 'https://github.com/o/r/pull/469',
  state: 'waiting_human',
  currentStep: 'merge',
  waitReason: null,
  failureReason: 'high risk',
  risk: {
    level: 'high',
    headSha: 'c2b585c51b2e99',
    reasons: ['touches a migration'],
    changedLines: 680,
  },
  approvedSha: null,
  awaitsApproval: true,
  approvalRequest: null,
};

beforeEach(() => request.mockReset());

describe('funny_factory_runs', () => {
  test('lists the runs with their state, risk and what they wait for', async () => {
    request.mockResolvedValue({
      factory: true,
      runs: [
        held,
        {
          ...held,
          id: 'run-2',
          issueNumber: 487,
          state: 'requested',
          currentStep: null,
          failureReason: null,
          risk: null,
          awaitsApproval: false,
          waitReason: { kind: 'paths-overlap', blockers: [482] },
        },
      ],
    });
    const result = await tool('funny_factory_runs')({});
    expect(request).toHaveBeenCalledWith('data:factory_list_runs', { threadId: THREAD });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('2 factory run(s)');
    expect(result.text).toContain('#451 — waiting_human (step merge) — run run-1');
    expect(result.text).toContain('risk: high at c2b585c, 680 changed lines');
    expect(result.text).toContain('waits for a member to approve merging it');
    expect(result.text).toContain('waits: paths-overlap (#482)');
  });

  test('says so when there is no factory, and when the server refuses', async () => {
    request.mockResolvedValue({ factory: false, runs: [] });
    expect((await tool('funny_factory_runs')({})).text).toContain('no issue factory');

    request.mockResolvedValue({ error: 'refused', message: 'Not in a sandbox thread.' });
    expect(await tool('funny_factory_runs')({})).toEqual({
      isError: true,
      text: 'Not in a sandbox thread.',
    });

    // The data channel's own denial.
    request.mockResolvedValue({ type: 'data:ack', success: false, error: 'Forbidden' });
    expect((await tool('funny_factory_runs')({})).isError).toBe(true);

    request.mockRejectedValue(new Error('transport down'));
    expect(await tool('funny_factory_runs')({})).toEqual({
      isError: true,
      text: 'Could not read the factory runs.',
    });
  });
});

describe('funny_factory_control', () => {
  test('sends the run and the action for the granted thread, whatever the model adds', async () => {
    request.mockResolvedValue({ run: { ...held, state: 'queued', awaitsApproval: false } });
    const result = await tool('funny_factory_control')({
      runId: 'run-1',
      action: 'retry',
      // A model cannot aim the tool at another thread or user.
      threadId: 'someone-elses-thread',
      userId: 'bob',
    });
    expect(request).toHaveBeenCalledWith('data:factory_control_run', {
      runId: 'run-1',
      action: 'retry',
      threadId: THREAD,
    });
    expect(result.text).toContain('Retried.');
    expect(result.text).toContain('#451 — queued');
  });

  test('offers no approve action', () => {
    const control = factoryToolDefinitions({ threadId: THREAD, userId: 'alice' }, request).find(
      (definition) => definition.name === 'funny_factory_control',
    );
    const action = control?.schema.action;
    expect(action?.safeParse('retry').success).toBe(true);
    expect(action?.safeParse('stop').success).toBe(true);
    expect(action?.safeParse('approve-merge').success).toBe(false);
  });

  test("passes the board's refusal on as an error", async () => {
    request.mockResolvedValue({ error: 'conflict', message: 'The run has already ended.' });
    expect(await tool('funny_factory_control')({ runId: 'run-1', action: 'stop' })).toEqual({
      isError: true,
      text: 'The run has already ended.',
    });
  });
});

describe('funny_factory_request_approval', () => {
  test('asks, and says nothing is approved', async () => {
    request.mockResolvedValue({
      requestId: 'q1',
      sha: 'c2b585c51b2e99',
      state: 'pending',
      created: true,
    });
    const result = await tool('funny_factory_request_approval')({ runId: 'run-1' });
    expect(request).toHaveBeenCalledWith('data:factory_request_approval', {
      runId: 'run-1',
      threadId: THREAD,
    });
    expect(result.text).toContain('Asked the user to approve merging commit c2b585c');
    expect(result.text).toContain('Nothing is approved yet');
  });

  test('asking twice reports the existing request', async () => {
    request.mockResolvedValue({
      requestId: 'q1',
      sha: 'c2b585c51b2e99',
      state: 'pending',
      created: false,
    });
    const result = await tool('funny_factory_request_approval')({ runId: 'run-1' });
    expect(result.text).toContain('already asked');
    expect(result.text).toContain('No second card');
  });

  test('a run that is not held is an error the agent can read', async () => {
    request.mockResolvedValue({
      error: 'conflict',
      message: 'This run is not waiting for an approval of a high-risk change.',
    });
    const result = await tool('funny_factory_request_approval')({ runId: 'run-1' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not waiting for an approval');
  });
});

describe('describeRun', () => {
  test('shows an approval and a request state', () => {
    const described = describeRun({
      ...held,
      state: 'merging',
      awaitsApproval: false,
      approvedSha: 'c2b585c51b2e99',
      approvalRequest: { id: 'q1', state: 'approved', sha: 'c2b585c51b2e99' },
    });
    expect(described).toContain('merge approved by a member at c2b585c');
    expect(described).toContain('approval request approved for c2b585c');
  });

  test('a run held again lists what changed since the approved commit', () => {
    const described = describeRun({
      ...held,
      approvedSha: 'c2b585c51b2e99',
      sinceApproval: {
        approvedSha: 'c2b585c51b2e99',
        lines: 8,
        files: ['src/new.ts', 'src/a.ts'],
        moreFiles: 2,
        newFiles: ['src/new.ts'],
        newRiskKeys: ['ci'],
      },
    });
    expect(described).toContain('since the approval of c2b585c: 8 lines of the change differ');
    expect(described).toContain('- src/new.ts (not in the approved change)');
    expect(described).toContain('- src/a.ts\n');
    expect(described).toContain('… and 2 more');
    expect(described).toContain('new risk reason: ci');
  });

  test('a difference that could not be computed says so', () => {
    const described = describeRun({
      ...held,
      sinceApproval: {
        approvedSha: 'c2b585c51b2e99',
        lines: null,
        files: [],
        moreFiles: 0,
        newFiles: [],
        newRiskKeys: [],
      },
    });
    expect(described).toContain('the difference could not be computed');
  });
});
