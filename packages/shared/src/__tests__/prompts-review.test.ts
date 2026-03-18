import { describe, test, expect } from 'bun:test';

import { buildReviewSystemPrompt, buildReviewUserPrompt } from '../prompts/review.js';

// ── buildReviewSystemPrompt ──────────────────────────────────────

describe('buildReviewSystemPrompt', () => {
  const prompt = buildReviewSystemPrompt();

  test('returns a non-empty string', () => {
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('contains severity levels', () => {
    for (const level of ['critical', 'high', 'medium', 'low', 'suggestion']) {
      expect(prompt).toContain(level);
    }
  });

  test('contains category keywords', () => {
    for (const cat of ['bug', 'security', 'performance', 'logic', 'maintainability']) {
      expect(prompt.toLowerCase()).toContain(cat);
    }
  });

  test('contains JSON format instructions', () => {
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"summary"');
  });

  test('is deterministic', () => {
    expect(buildReviewSystemPrompt()).toBe(prompt);
  });
});

// ── buildReviewUserPrompt ────────────────────────────────────────

describe('buildReviewUserPrompt', () => {
  test('includes PR title in output', () => {
    const result = buildReviewUserPrompt('My PR Title', '', 'diff content');
    expect(result).toContain('My PR Title');
  });

  test('includes PR body when provided', () => {
    const result = buildReviewUserPrompt('Title', 'This fixes a bug', 'diff');
    expect(result).toContain('### Description');
    expect(result).toContain('This fixes a bug');
  });

  test('omits description section when prBody is empty', () => {
    const result = buildReviewUserPrompt('Title', '', 'diff');
    expect(result).not.toContain('### Description');
  });

  test('includes diff in code fence', () => {
    const result = buildReviewUserPrompt('Title', '', '+ added line');
    expect(result).toContain('```diff');
    expect(result).toContain('+ added line');
    expect(result).toContain('```');
  });

  test('truncates diff exceeding 100,000 characters', () => {
    const longDiff = 'x'.repeat(100_001);
    const result = buildReviewUserPrompt('Title', '', longDiff);
    expect(result).toContain('... (diff truncated)');
    expect(result).not.toContain('x'.repeat(100_001));
  });

  test('does not truncate diff at exactly 100,000 characters', () => {
    const exactDiff = 'x'.repeat(100_000);
    const result = buildReviewUserPrompt('Title', '', exactDiff);
    expect(result).not.toContain('truncated');
    expect(result).toContain(exactDiff);
  });

  test('handles empty diff gracefully', () => {
    const result = buildReviewUserPrompt('Title', '', '');
    expect(result).toContain('```diff');
    expect(result).toContain('Analyze this diff');
  });

  test('ends with JSON analysis instruction', () => {
    const result = buildReviewUserPrompt('Title', '', 'diff');
    expect(result.trim()).toMatch(/JSON\.?$/);
  });
});
