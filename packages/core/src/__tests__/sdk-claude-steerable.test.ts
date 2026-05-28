import { describe, test, expect } from 'vitest';

import { SDKClaudeProcess } from '../agents/sdk-claude.js';
import type { ClaudeProcessOptions } from '../agents/types.js';

// These tests exercise the steering gate WITHOUT starting a query — the
// constructor only binds the live-reuse hooks; no SDK process is spawned.

const baseOpts: ClaudeProcessOptions = { prompt: 'hi', cwd: '/tmp' };

describe('SDKClaudeProcess steerable gating', () => {
  test('steerable thread exposes sendPrompt + steerPrompt', () => {
    const proc = new SDKClaudeProcess({ ...baseOpts, steerable: true });
    expect(typeof (proc as any).sendPrompt).toBe('function');
    expect(typeof (proc as any).steerPrompt).toBe('function');
  });

  test('non-steerable thread does NOT expose sendPrompt (so the orchestrator falls back to kill+respawn)', () => {
    const proc = new SDKClaudeProcess({ ...baseOpts, steerable: false });
    expect((proc as any).sendPrompt).toBeUndefined();
  });

  test('steerPrompt throws when there is no live session yet (orchestrator then falls back)', async () => {
    const proc = new SDKClaudeProcess({ ...baseOpts, steerable: true });
    await expect((proc as any).steerPrompt('redirect')).rejects.toThrow('claude-live-unavailable');
  });

  test('input channel yields pushed messages in FIFO order, wakes a pending reader, and closes cleanly', async () => {
    const proc = new SDKClaudeProcess({ ...baseOpts, steerable: true }) as any;
    const gen = proc.consumeInput();

    // Queued-ahead messages drain in order with the SDK user-message shape.
    proc.pushInput('first');
    proc.pushInput('second');
    const a = await gen.next();
    expect(a.done).toBe(false);
    expect(a.value.type).toBe('user');
    expect(a.value.message.content[0].text).toBe('first');
    expect((await gen.next()).value.message.content[0].text).toBe('second');

    // Reader that arrives before input is parked, then woken by the next push.
    const pending = gen.next();
    proc.pushInput('third');
    expect((await pending).value.message.content[0].text).toBe('third');

    // closeInput() terminates the generator even with no queued input.
    proc.closeInput();
    expect((await gen.next()).done).toBe(true);
  });
});
