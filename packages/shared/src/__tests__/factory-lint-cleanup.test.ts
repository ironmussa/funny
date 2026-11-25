import { describe, expect, test } from 'bun:test';

import {
  isBehaviorNeutralLintCleanup,
  lintCleanupSource,
  normalizeLintRule,
  type FactoryContract,
} from '../contracts/factory.js';

const contract = (extra: Partial<FactoryContract>): FactoryContract => ({
  acceptanceCriteria: ['no warnings'],
  likelyPaths: [],
  riskHints: [],
  ...extra,
});

describe('lint-cleanup class', () => {
  test('a rule reads the same however the linter prints it', () => {
    expect(normalizeLintRule('max-lines')).toBe('eslint/max-lines');
    expect(normalizeLintRule('eslint(max-lines-per-function)')).toBe(
      'eslint/max-lines-per-function',
    );
    expect(normalizeLintRule(' ESLint/Max-Lines ')).toBe('eslint/max-lines');
    expect(normalizeLintRule('anti-slop/no-unknown-returns')).toBe('anti-slop/no-unknown-returns');
  });

  test('holds only when triage names rules, all of them neutral', () => {
    const neutral = ['eslint/max-lines', 'max-lines-per-function'];
    expect(isBehaviorNeutralLintCleanup(contract({ lintCleanup: true, lintRules: neutral }))).toBe(
      true,
    );
    // No rules named, or not proposed at all.
    expect(isBehaviorNeutralLintCleanup(contract({ lintCleanup: true }))).toBe(false);
    expect(isBehaviorNeutralLintCleanup(contract({ lintCleanup: true, lintRules: [] }))).toBe(
      false,
    );
    expect(isBehaviorNeutralLintCleanup(contract({ lintRules: neutral }))).toBe(false);
    expect(isBehaviorNeutralLintCleanup(null)).toBe(false);
    // One rule whose fix can change behavior is enough to refuse (#484's case).
    expect(
      isBehaviorNeutralLintCleanup(
        contract({
          lintCleanup: true,
          lintRules: ['eslint/max-lines', 'anti-slop/no-unknown-parameters'],
        }),
      ),
    ).toBe(false);
    // A plugin's rule of the same name is not eslint's.
    expect(
      isBehaviorNeutralLintCleanup(contract({ lintCleanup: true, lintRules: ['other/max-lines'] })),
    ).toBe(false);
  });

  test("a member's veto overrules triage", () => {
    const triage = {
      decision: 'ready' as const,
      at: '2026-11-25T00:00:00.000Z',
      contract: contract({ lintCleanup: true, lintRules: ['eslint/max-lines'] }),
    };
    expect(lintCleanupSource({ triage, riskWaiver: null })).toBe('triage');
    expect(
      lintCleanupSource({
        triage,
        riskWaiver: { kind: 'not-lint-cleanup', userId: 'u1', at: triage.at },
      }),
    ).toBeNull();
  });
});
