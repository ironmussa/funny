import { describe, expect, it } from 'vitest';

import { buildLogTail, MAX_TAIL_CHARS } from '../../services/job-log-tail.js';

describe('buildLogTail', () => {
  it('collapses carriage-return progress-bar overwrites to the final state', () => {
    // A tqdm-style progress bar: many states on ONE newline-terminated line,
    // separated by \r. This is the real shape that produced 350 KB+ messages.
    const states = Array.from({ length: 5000 }, (_, i) => `${i}/5000 [00:0${i % 9}<?, ?f/s]`);
    const raw = `starting job\n${states.join('\r')}\ndone -> output.mp4\n`;

    const tail = buildLogTail(raw);

    // Only the final progress state survives, not the whole history.
    expect(tail).toContain('4999/5000');
    expect(tail).not.toContain('0/5000');
    expect(tail).toContain('done -> output.mp4');
    // The pathological 350 KB collapses to a tiny tail.
    expect(tail.length).toBeLessThan(1_000);
  });

  it('caps the tail at MAX_TAIL_CHARS even without carriage returns', () => {
    const huge = 'x'.repeat(MAX_TAIL_CHARS * 3);
    const tail = buildLogTail(huge);
    expect(tail.length).toBeLessThanOrEqual(MAX_TAIL_CHARS + '…(truncated)\n'.length);
    expect(tail.startsWith('…(truncated)')).toBe(true);
  });

  it('strips ANSI escape sequences', () => {
    const tail = buildLogTail('\x1b[32mgreen\x1b[0m text');
    expect(tail).toBe('green text');
  });

  it('keeps only the last N newline-delimited lines', () => {
    const raw = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const tail = buildLogTail(raw, 10);
    expect(tail).toContain('line 99');
    expect(tail).not.toContain('line 89');
    expect(tail.split('\n')).toHaveLength(10);
  });

  it('returns (empty) for whitespace-only input', () => {
    expect(buildLogTail('   \n  \n')).toBe('(empty)');
  });
});
