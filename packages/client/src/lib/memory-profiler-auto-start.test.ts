import { describe, expect, it, vi } from 'vitest';

import { AUTO_MEMORY_PROFILE_OPTIONS, autoStartMemoryProfiler } from './memory-profiler-auto-start';

describe('autoStartMemoryProfiler', () => {
  it.each([undefined, '', 'false', '1'])('does not start when the flag is %j', (enabled) => {
    const start = vi.fn();

    expect(autoStartMemoryProfiler({ start }, enabled)).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a bounded investigation run when enabled', () => {
    const status = {
      sessionId: 'memory-session',
      running: true,
      intervalMs: 30_000,
      maxSamples: 1_440,
      retainedSamples: 1,
      startedAt: '2026-09-01T20:00:00.000Z',
    };
    const start = vi.fn(() => status);

    expect(autoStartMemoryProfiler({ start }, 'true')).toBe(status);
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(AUTO_MEMORY_PROFILE_OPTIONS);
  });
});
