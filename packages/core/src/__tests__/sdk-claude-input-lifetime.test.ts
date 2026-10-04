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

  test('session_state_changed idle closes even with a task still tracked', async () => {
    const ch = await setup();
    ch.track(sys('task_started', { task_id: 't3', is_backgrounded: true }));
    ch.track(sys('session_state_changed', { state: 'idle' }));
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
