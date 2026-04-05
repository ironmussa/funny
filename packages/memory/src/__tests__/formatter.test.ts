import { describe, it, expect } from 'vitest';

import { formatRecallContext } from '../formatter.js';
import type { OperatorProfile } from '../types.js';
import { makeFact } from './helpers.js';

describe('formatter', () => {
  describe('formatRecallContext', () => {
    it('returns empty string for empty facts and no operator', () => {
      expect(formatRecallContext([])).toBe('');
    });

    it('wraps output in [PROJECT MEMORY] tags', () => {
      const facts = [makeFact({ type: 'decision', content: 'Use React' })];
      const result = formatRecallContext(facts);
      expect(result).toContain('[PROJECT MEMORY]');
      expect(result).toContain('[/PROJECT MEMORY]');
    });

    it('includes skepticism disclaimer', () => {
      const facts = [makeFact({ type: 'decision', content: 'Use React' })];
      const result = formatRecallContext(facts);
      expect(result).toContain('These memories may be stale');
    });

    it('groups facts by type with correct labels', () => {
      const facts = [
        makeFact({ type: 'decision', content: 'Use React for frontend' }),
        makeFact({ type: 'bug', content: 'Memory leak in worker' }),
        makeFact({ type: 'decision', content: 'Use Hono for API' }),
      ];
      const result = formatRecallContext(facts);
      expect(result).toContain('**Decisions:**');
      expect(result).toContain('**Known Issues:**');
      expect(result).toContain('Use React for frontend');
      expect(result).toContain('Memory leak in worker');
      expect(result).toContain('Use Hono for API');
    });

    it('shows age for facts', () => {
      const now = new Date();
      const facts = [
        makeFact({ type: 'insight', content: 'Test insight', ingestedAt: now.toISOString() }),
      ];
      const result = formatRecallContext(facts);
      expect(result).toContain('(today)');
    });

    it('shows confidence when below 1.0', () => {
      const facts = [makeFact({ type: 'insight', content: 'Low conf fact', confidence: 0.6 })];
      const result = formatRecallContext(facts);
      expect(result).toContain('[confidence: 0.60]');
    });

    it('does not show confidence when exactly 1.0', () => {
      const facts = [makeFact({ type: 'insight', content: 'High conf fact', confidence: 1.0 })];
      const result = formatRecallContext(facts);
      expect(result).not.toContain('[confidence:');
    });

    it('truncates long content to first line', () => {
      const longContent = 'First line\nSecond line\nThird line with much more text';
      const facts = [makeFact({ type: 'insight', content: longContent })];
      const result = formatRecallContext(facts);
      expect(result).toContain('First line');
      expect(result).not.toContain('Second line');
    });

    it('respects type ordering', () => {
      const facts = [
        makeFact({ type: 'context', content: 'Context fact' }),
        makeFact({ type: 'decision', content: 'Decision fact' }),
        makeFact({ type: 'bug', content: 'Bug fact' }),
      ];
      const result = formatRecallContext(facts);
      const decisionPos = result.indexOf('Decision fact');
      const bugPos = result.indexOf('Bug fact');
      const contextPos = result.indexOf('Context fact');
      // decision < bug < context in output order
      expect(decisionPos).toBeLessThan(bugPos);
      expect(bugPos).toBeLessThan(contextPos);
    });

    // ─── Operator section ───────────────────────────

    it('includes operator profile when provided', () => {
      const operator: OperatorProfile = {
        operator: 'alice',
        role: 'Senior Engineer',
        expertise: ['React', 'TypeScript'],
        preferences: ['Prefer functional components'],
      };
      const result = formatRecallContext([], operator);
      expect(result).toContain('alice');
      expect(result).toContain('Senior Engineer');
      expect(result).toContain('React');
      expect(result).toContain('Prefer functional components');
    });

    it('renders operator even with no facts', () => {
      const operator: OperatorProfile = { operator: 'bob' };
      const result = formatRecallContext([], operator);
      expect(result).toContain('bob');
      expect(result).toContain('[PROJECT MEMORY]');
    });

    // ─── Token budget ───────────────────────────────

    it('truncates output that exceeds 8000 chars', () => {
      // Generate many facts to exceed the budget
      const facts = Array.from({ length: 200 }, (_, i) =>
        makeFact({
          type: 'insight',
          content: `Fact number ${i} with enough content to fill the budget quickly: ${'x'.repeat(100)}`,
        }),
      );
      const result = formatRecallContext(facts);
      // Should contain truncation marker
      expect(result).toContain('truncated');
      // The total before wrapping in tags should respect the budget
    });
  });
});
