import type { Client } from '@libsql/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  checkAdmission,
  shouldConsolidate,
  markConsolidated,
  trackCompletion,
} from '../consolidator.js';
import type { LLMConfig } from '../llm.js';
import { setMeta, getMeta } from '../storage.js';
import { createTestDb } from './helpers.js';

describe('consolidator', () => {
  const llmConfig: LLMConfig = {
    baseUrl: 'http://localhost:4010',
    model: 'test-model',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    markConsolidated(); // reset counter
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── checkAdmission ─────────────────────────────────

  describe('checkAdmission', () => {
    it('rejects content matching file path pattern', async () => {
      const result = await checkAdmission(llmConfig, 'packages/memory/src/index.ts');
      expect(result.admitted).toBe(false);
      expect(result.reason).toContain('derivable pattern');
    });

    it('rejects content matching git history pattern', async () => {
      const result = await checkAdmission(llmConfig, 'git log shows recent commits');
      expect(result.admitted).toBe(false);
    });

    it('rejects content matching function signature pattern', async () => {
      const result = await checkAdmission(llmConfig, 'function calculateDecayScore(fact, now)');
      expect(result.admitted).toBe(false);
    });

    it('rejects import statements', async () => {
      const result = await checkAdmission(llmConfig, "import { foo } from './bar'");
      expect(result.admitted).toBe(false);
    });

    it('rejects test/build output', async () => {
      const result = await checkAdmission(llmConfig, 'test passed with 100% coverage');
      expect(result.admitted).toBe(false);
    });

    it('rejects PR references', async () => {
      const result = await checkAdmission(llmConfig, 'PR #123 was merged yesterday');
      expect(result.admitted).toBe(false);
    });

    it('rejects stack trace references', async () => {
      const result = await checkAdmission(llmConfig, 'the stack trace shows a null pointer');
      expect(result.admitted).toBe(false);
    });

    it('rejects npm/bun commands', async () => {
      const result = await checkAdmission(llmConfig, 'bun install failed with error');
      expect(result.admitted).toBe(false);
    });

    it('calls LLM for non-obvious content', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'r', status: 'completed', result: { text: 'ACCEPT' } }), {
          status: 200,
        }),
      );

      const result = await checkAdmission(
        llmConfig,
        'The team decided to use event sourcing for the audit log because compliance requires full traceability',
      );
      expect(result.admitted).toBe(true);
    });

    it('rejects when LLM says REJECT', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'r', status: 'completed', result: { text: 'REJECT' } }), {
          status: 200,
        }),
      );

      const result = await checkAdmission(
        llmConfig,
        'The src folder contains components and utils directories',
      );
      expect(result.admitted).toBe(false);
      expect(result.reason).toContain('LLM classified');
    });

    it('admits by default if LLM fails (fail open)', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection refused'));

      const result = await checkAdmission(
        llmConfig,
        'Some ambiguous content that might or might not be derivable',
      );
      expect(result.admitted).toBe(true);
    });
  });

  // ─── Trigger logic ──────────────────────────────────

  describe('shouldConsolidate', () => {
    let db: Client;

    beforeEach(async () => {
      db = await createTestDb();
    });

    it('returns true when no last consolidation', async () => {
      expect(await shouldConsolidate(db)).toBe(true);
    });

    it('returns true after enough thread completions', async () => {
      await setMeta(db, 'last_consolidation', new Date().toISOString());
      markConsolidated();

      // Track 10 completions (threshold)
      for (let i = 0; i < 10; i++) trackCompletion();
      expect(await shouldConsolidate(db)).toBe(true);
    });

    it('returns true when 6+ hours since last run', async () => {
      const sevenHoursAgo = new Date(Date.now() - 7 * 3_600_000).toISOString();
      await setMeta(db, 'last_consolidation', sevenHoursAgo);
      markConsolidated();

      expect(await shouldConsolidate(db)).toBe(true);
    });

    it('returns false when recent and below threshold', async () => {
      await setMeta(db, 'last_consolidation', new Date().toISOString());
      markConsolidated();

      // Only 2 completions
      trackCompletion();
      trackCompletion();
      expect(await shouldConsolidate(db)).toBe(false);
    });
  });

  describe('markConsolidated', () => {
    it('resets the thread counter', async () => {
      const db = await createTestDb();
      await setMeta(db, 'last_consolidation', new Date().toISOString());

      for (let i = 0; i < 10; i++) trackCompletion();
      expect(await shouldConsolidate(db)).toBe(true);

      markConsolidated();
      expect(await shouldConsolidate(db)).toBe(false);
    });
  });
});
