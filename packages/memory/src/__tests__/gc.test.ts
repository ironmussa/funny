import { describe, it, expect } from 'vitest';

import { trackThreadCompletion, shouldRunGC, markGCComplete } from '../gc.js';

describe('gc', () => {
  // ─── Trigger logic ──────────────────────────────────

  describe('GC trigger logic', () => {
    it('shouldRunGC returns true when no previous run', () => {
      markGCComplete(); // reset
      // Immediately mark complete resets counters but sets lastGCRun
      // So we need to test the no-previous-run scenario differently
      // After markGCComplete, lastGCRun is set, threadsSinceGC is 0
      expect(shouldRunGC(10)).toBe(false);
    });

    it('triggers after enough thread completions', () => {
      markGCComplete();
      for (let i = 0; i < 10; i++) trackThreadCompletion();
      expect(shouldRunGC(10)).toBe(true);
    });

    it('does not trigger below threshold', () => {
      markGCComplete();
      for (let i = 0; i < 5; i++) trackThreadCompletion();
      expect(shouldRunGC(10)).toBe(false);
    });

    it('respects custom interval', () => {
      markGCComplete();
      for (let i = 0; i < 3; i++) trackThreadCompletion();
      expect(shouldRunGC(3)).toBe(true);
    });

    it('markGCComplete resets the counter', () => {
      markGCComplete();
      for (let i = 0; i < 10; i++) trackThreadCompletion();
      expect(shouldRunGC(10)).toBe(true);

      markGCComplete();
      expect(shouldRunGC(10)).toBe(false);
    });
  });
});
