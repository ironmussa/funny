import { afterEach, describe, expect, test, vi } from 'bun:test';

import { EMPTY_RESUME_RESULT_HOLD_MS, SDKClaudeProcess } from '../agents/sdk-claude.js';
import type { ClaudeProcessOptions, CLIMessage } from '../agents/types.js';
import { sdkMessage, type SdkWireFields } from './helpers/test-helpers.js';

// Regression (issue #343): resuming an interrupted session, the CLI closes the
// dangling turn with a `success` result of 0 turns, then runs the queued prompt
// in the same process. Publishing that result marked the thread completed, and
// the issue factory ended the `implement` step on it while the agent was still
// working. Sequence from the incident (factory run 1cca3fa8, Claude Code CLI):
//   system:init → result(success, num_turns 0, 161 ms) → system:init → assistant …

const init = { type: 'system', subtype: 'init', session_id: 's1', tools: [] };
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
const emptyResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 0,
  duration_ms: 161,
  total_cost_usd: 6.6,
  result: '',
};
const assistant = {
  type: 'assistant',
  message: {
    id: 'm1',
    role: 'assistant',
    model: 'claude',
    content: [{ type: 'text', text: 'Resuming.' }],
  },
};
const finalResult = { ...emptyResult, num_turns: 4, duration_ms: 39_342, total_cost_usd: 8.5 };

/** Drive a process the way the SDK query loop does; collect what reaches the runtime. */
function stream(opts: Partial<ClaudeProcessOptions> = {}) {
  const proc = new SDKClaudeProcess({ prompt: 'continue', cwd: '/tmp', ...opts });
  const published: CLIMessage[] = [];
  proc.on('message', (m: CLIMessage) => published.push(m));
  const receive = <F extends SdkWireFields>(fields: F) => {
    const msg = sdkMessage(fields);
    if (proc['screenResumeResult'](msg)) return;
    proc['trackInputLifetime'](msg);
    const cli = proc['translateMessage'](msg);
    if (cli) proc.emit('message', cli);
  };
  const results = () => published.filter((m) => m.type === 'result');
  return { proc, receive, results };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SDKClaudeProcess empty resume result', () => {
  test('drops it when the resumed session goes on to a turn', () => {
    const { proc, receive, results } = stream({ sessionId: 's1' });
    receive(init);
    receive(emptyResult);
    expect(results()).toEqual([]);
    expect(proc['inputClosed']).toBe(false); // the queued prompt's tool calls still need the hook

    receive(init);
    receive(assistant);
    receive(finalResult);
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ num_turns: 4, total_cost_usd: 8.5 });
    expect(proc['inputClosed']).toBe(true);
  });

  test('publishes it once when the session goes idle instead', () => {
    const { proc, receive, results } = stream({ sessionId: 's1' });
    receive(init);
    receive(emptyResult);
    receive(idle);
    receive(idle);
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ num_turns: 0, total_cost_usd: 6.6 });
    expect(proc['inputClosed']).toBe(true);
  });

  test('publishes it when nothing follows within the hold time', () => {
    vi.useFakeTimers();
    const { proc, receive, results } = stream({ sessionId: 's1' });
    receive(emptyResult);
    vi.advanceTimersByTime(EMPTY_RESUME_RESULT_HOLD_MS - 1);
    expect(results()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(results()).toHaveLength(1);
    expect(proc['inputClosed']).toBe(true);
  });

  test('publishes it when the query ends', () => {
    const { proc, receive, results } = stream({ sessionId: 's1' });
    receive(emptyResult);
    proc['releaseResumeResult'](); // the query loop's `finally`
    expect(results()).toHaveLength(1);
  });

  test('a killed process never publishes it', async () => {
    vi.useFakeTimers();
    const { proc, receive, results } = stream({ sessionId: 's1' });
    receive(emptyResult);
    await proc.kill();
    vi.advanceTimersByTime(EMPTY_RESUME_RESULT_HOLD_MS);
    proc['releaseResumeResult']();
    expect(results()).toEqual([]);
  });

  test('a fresh query publishes a 0-turn result at once', () => {
    const { receive, results } = stream();
    receive(emptyResult);
    expect(results()).toHaveLength(1);
  });

  test('a 0-turn result after model output is the real end', () => {
    const { receive, results } = stream({ sessionId: 's1' });
    receive(assistant);
    receive(emptyResult);
    expect(results()).toHaveLength(1);
  });

  test('error results are never held (stale-session recovery needs them)', () => {
    const { receive, results } = stream({ sessionId: 's1' });
    const error = { ...emptyResult, subtype: 'error_during_execution', is_error: true };
    receive(error);
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ subtype: 'error_during_execution' });
  });
});
