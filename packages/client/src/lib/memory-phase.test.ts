import { afterEach, describe, expect, it, vi } from 'vitest';

import { markMemoryPhase } from './memory-phase';

type Globals = typeof globalThis & { __funnyMemory?: unknown };

function installProfiler(running: boolean, mark = vi.fn()) {
  (globalThis as Globals).__funnyMemory = { mark, status: () => ({ running }) };
  return mark;
}

afterEach(() => {
  delete (globalThis as Globals).__funnyMemory;
});

describe('markMemoryPhase', () => {
  it('marks the phase while a run is active', () => {
    const mark = installProfiler(true);

    markMemoryPhase('browser-session-open');

    expect(mark).toHaveBeenCalledWith('browser-session-open');
  });

  it('stays silent when no run is active', () => {
    const mark = installProfiler(false);

    markMemoryPhase('thread-open');

    // `mark()` on an idle profiler would start recording samples nobody asked for.
    expect(mark).not.toHaveBeenCalled();
  });

  it('is a no-op when the profiler was never installed', () => {
    expect(() => markMemoryPhase('terminal-open')).not.toThrow();
  });

  it('tolerates a partially shaped global', () => {
    (globalThis as Globals).__funnyMemory = { mark: vi.fn() }; // no status()

    expect(() => markMemoryPhase('terminal-close')).not.toThrow();
  });

  it('never lets a failing profiler break the observed path', () => {
    installProfiler(
      true,
      vi.fn(() => {
        throw new Error('profiler exploded');
      }),
    );

    expect(() => markMemoryPhase('thread-open')).not.toThrow();
  });
});
