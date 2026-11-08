import { describe, test, expect } from 'vitest';

import { SDKClaudeProcess } from '../agents/sdk-claude.js';
import type { ClaudeProcessOptions } from '../agents/types.js';

// Regression: the SDK closes the CLI's stdin when the input channel ends.
// With stdin closed the CLI can no longer reach our PreToolUse hook, so tool
// calls made by background subagents after the main turn's `result` were
// auto-denied ("The user doesn't want to take this action right now").
// These tests drive the channel directly — no SDK process is spawned.

const baseOpts: ClaudeProcessOptions = { prompt: 'hi', cwd: '/tmp' };

const result = { type: 'result', subtype: 'success' };
const sys = (subtype: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype,
  ...extra,
});

/** Drain the seeded prompt, then report whether the channel has ended. */
async function setup(opts: Partial<ClaudeProcessOptions> = {}) {
  const proc = new SDKClaudeProcess({ ...baseOpts, ...opts }) as any;
  const input = proc.buildPromptInput();
  const it = input[Symbol.asyncIterator]();
  const first = await it.next();
  let ended = false;
  const pending = it.next().then((r: IteratorResult<unknown>) => {
    ended = !!r.done;
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    proc,
    first,
    track: (msg: unknown) => proc.trackInputLifetime(msg),
    isClosed: async () => {
      await flush();
      return ended;
    },
    pending,
  };
}

describe('SDKClaudeProcess input-channel lifetime', () => {
  test('non-steerable prompt is streamed, never a plain string (single-turn closes stdin early)', async () => {
    const { first } = await setup();
    expect(first.done).toBe(false);
    expect((first.value as any).message.content[0].text).toBe('hi');
  });

  test('closes on result when no background task is running', async () => {
    const ch = await setup();
    ch.track(result);
    expect(await ch.isClosed()).toBe(true);
  });

  test('stays open past result while a background subagent runs, closes after its final result', async () => {
    const ch = await setup();
    ch.track(sys('task_started', { task_id: 't1', is_backgrounded: true }));
    ch.track(result); // main turn ends — subagent still needs the hook
    expect(await ch.isClosed()).toBe(false);

    ch.track(sys('task_notification', { task_id: 't1', status: 'completed' }));
    expect(await ch.isClosed()).toBe(false); // CLI runs a follow-up turn first
    ch.track(result);
    expect(await ch.isClosed()).toBe(true);
  });

  test('ignores foreground and ambient tasks', async () => {
    const ch = await setup();
    ch.track(sys('task_started', { task_id: 'fg', is_backgrounded: false }));
    ch.track(sys('task_started', { task_id: 'amb', is_backgrounded: true, ambient: true }));
    ch.track(result);
    expect(await ch.isClosed()).toBe(true);
  });

  test('tracks tasks moved to the background and their terminal task_updated', async () => {
    const ch = await setup();
    ch.track(sys('task_updated', { task_id: 't2', patch: { is_backgrounded: true } }));
    ch.track(result);
    expect(await ch.isClosed()).toBe(false);
    ch.track(sys('task_updated', { task_id: 't2', patch: { status: 'killed' } }));
    ch.track(result);
    expect(await ch.isClosed()).toBe(true);
  });

  // Sequence captured from the real CLI (SDK 0.3.314): `idle` arrives right
  // after the turn's result while a run_in_background Bash is still running.
  // Closing there auto-denied every tool call of the notification turn.
  test('idle does not close while a background Bash runs; closes after the notification turn', async () => {
    const ch = await setup();
    const task = { task_id: 'b1', task_type: 'local_bash', description: 'suite' };
    ch.track(sys('background_tasks_changed', { tasks: [task] }));
    ch.track(sys('task_started', { task_id: 'b1', is_backgrounded: true }));
    ch.track(result);
    ch.track(sys('session_state_changed', { state: 'idle' }));
    expect(await ch.isClosed()).toBe(false);

    ch.track(sys('task_updated', { task_id: 'b1', patch: { status: 'completed' } }));
    ch.track(sys('task_notification', { task_id: 'b1', status: 'completed' }));
    ch.track(sys('background_tasks_changed', { tasks: [] }));
    ch.track(sys('session_state_changed', { state: 'running' }));
    expect(await ch.isClosed()).toBe(false);
    ch.track(result);
    expect(await ch.isClosed()).toBe(true);
  });

  test('background_tasks_changed replaces the set, healing a missed end edge', async () => {
    const ch = await setup();
    ch.track(sys('task_started', { task_id: 'lost', is_backgrounded: true }));
    ch.track(result);
    expect(await ch.isClosed()).toBe(false);
    ch.track(sys('background_tasks_changed', { tasks: [] }));
    ch.track(sys('session_state_changed', { state: 'idle' }));
    expect(await ch.isClosed()).toBe(true);
  });

  test('ambient entries in background_tasks_changed do not keep the channel open', async () => {
    const ch = await setup();
    ch.track(sys('background_tasks_changed', { tasks: [{ task_id: 'w', ambient: true }] }));
    ch.track(result);
    expect(await ch.isClosed()).toBe(true);
  });

  test('steerable threads keep the channel open past result', async () => {
    const ch = await setup({ steerable: true });
    ch.track(result);
    ch.track(sys('session_state_changed', { state: 'idle' }));
    expect(await ch.isClosed()).toBe(false);
    ch.proc.closeInput();
    expect(await ch.isClosed()).toBe(true);
  });
});

// Drive tracking and translation in the same order as the SDK query loop.
// Only translated results reach the runtime and can mark the thread completed.
function messageStream(opts: Partial<ClaudeProcessOptions> = {}) {
  const proc = new SDKClaudeProcess({ ...baseOpts, ...opts }) as any;
  return (msg: unknown) => {
    proc.trackInputLifetime(msg);
    return proc.translateMessage(msg);
  };
}

describe('SDKClaudeProcess completion with background agents', () => {
  test.each([false, true])(
    'waits for all agents and the follow-up result (steerable=%s)',
    (steerable) => {
      const receive = messageStream({ steerable });
      receive(sys('task_started', { task_id: 'a', is_backgrounded: true }));
      receive(sys('task_updated', { task_id: 'b', patch: { is_backgrounded: true } }));
      expect(receive({ ...result, total_cost_usd: 1 })).toBeNull();
      expect(receive(sys('task_notification', { task_id: 'a', status: 'completed' }))).toBeNull();
      expect(receive({ ...result, total_cost_usd: 2 })).toBeNull();
      expect(
        receive(sys('task_updated', { task_id: 'b', patch: { status: 'completed' } })),
      ).toBeNull();
      const final = {
        ...result,
        total_cost_usd: 3,
        duration_ms: 100,
        num_turns: 4,
        session_id: 'session',
      };
      expect(receive(final)).toMatchObject(final);
      expect(receive(sys('session_state_changed', { state: 'idle' }))).toBeNull();
    },
  );

  test.each([false, true])(
    'idle releases the latest deferred result once (steerable=%s)',
    (steerable) => {
      const receive = messageStream({ steerable });
      receive(sys('task_started', { task_id: 'a', is_backgrounded: true }));
      expect(receive({ ...result, total_cost_usd: 1 })).toBeNull();
      // Idle while the task still runs is only the end of a turn.
      expect(receive(sys('session_state_changed', { state: 'idle' }))).toBeNull();
      expect(receive({ ...result, total_cost_usd: 2 })).toBeNull();
      receive(sys('background_tasks_changed', { tasks: [] }));
      expect(receive(sys('session_state_changed', { state: 'idle' }))).toMatchObject({
        ...result,
        total_cost_usd: 2,
      });
      expect(receive(sys('session_state_changed', { state: 'idle' }))).toBeNull();
      if (steerable) expect(receive(result)).toMatchObject(result);
    },
  );

  test('errors supersede a deferred success even while an agent is running', () => {
    const receive = messageStream();
    receive(sys('task_started', { task_id: 'a', is_backgrounded: true }));
    expect(receive(result)).toBeNull();
    const failure = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['failed'],
    };
    expect(receive(failure)).toMatchObject(failure);
    expect(receive(sys('session_state_changed', { state: 'idle' }))).toBeNull();
  });

  test('foreground and ambient tasks do not defer completion', () => {
    const receive = messageStream();
    receive(sys('task_started', { task_id: 'fg', is_backgrounded: false }));
    receive(sys('task_started', { task_id: 'ambient', is_backgrounded: true, ambient: true }));
    expect(receive(result)).toMatchObject(result);
  });
});
