import { describe, expect, test } from 'vitest';

import { shouldForceColdPathRecovery } from '../../services/agent-startup/cold-path-guard.js';

describe('shouldForceColdPathRecovery', () => {
  const baseThread = {
    sessionId: 'sess-1',
    contextRecoveryReason: null,
    mergedAt: null,
  };

  test('returns true for gemini when process is gone and session exists', () => {
    expect(
      shouldForceColdPathRecovery({
        thread: baseThread,
        isRunning: false,
        provider: 'gemini',
      }),
    ).toBe(true);
  });

  test('returns true for codex on cold path', () => {
    expect(
      shouldForceColdPathRecovery({
        thread: baseThread,
        isRunning: false,
        provider: 'codex',
      }),
    ).toBe(true);
  });

  // Regression: Claude SDK resumes by sessionId without the loadSession replay
  // race. Forcing recovery here invalidates the prompt cache on every
  // follow-up and burns ~25k cache_creation tokens per turn.
  test('returns false for claude even when the process is gone', () => {
    expect(
      shouldForceColdPathRecovery({
        thread: baseThread,
        isRunning: false,
        provider: 'claude',
      }),
    ).toBe(false);
  });

  test('returns false when the agent process is still running', () => {
    expect(
      shouldForceColdPathRecovery({
        thread: baseThread,
        isRunning: true,
        provider: 'gemini',
      }),
    ).toBe(false);
  });

  test('returns false when there is no persisted sessionId', () => {
    expect(
      shouldForceColdPathRecovery({
        thread: { ...baseThread, sessionId: null },
        isRunning: false,
        provider: 'gemini',
      }),
    ).toBe(false);
  });

  test('returns false when contextRecoveryReason is already set', () => {
    expect(
      shouldForceColdPathRecovery({
        thread: { ...baseThread, contextRecoveryReason: 'provider_changed' },
        isRunning: false,
        provider: 'gemini',
      }),
    ).toBe(false);
  });

  test('returns false for post-merge threads', () => {
    expect(
      shouldForceColdPathRecovery({
        thread: { ...baseThread, mergedAt: '2026-05-10T00:00:00Z' },
        isRunning: false,
        provider: 'gemini',
      }),
    ).toBe(false);
  });

  test('returns false when thread is null', () => {
    expect(
      shouldForceColdPathRecovery({
        thread: null,
        isRunning: false,
        provider: 'gemini',
      }),
    ).toBe(false);
  });
});
