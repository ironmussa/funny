import { describe, expect, test } from 'bun:test';

import { canShowRecap, shouldOfferRecap } from '@/lib/thread-variant';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const CREATED = minutesAgo(60);

describe('shouldOfferRecap (openspec thread-recap)', () => {
  test('last read 20 minutes ago with new messages offers a recap', () => {
    expect(shouldOfferRecap(minutesAgo(20), minutesAgo(1), NOW, CREATED)).toBe(true);
  });

  test('last read 2 minutes ago with new messages does not', () => {
    expect(shouldOfferRecap(minutesAgo(2), minutesAgo(1), NOW, CREATED)).toBe(false);
  });

  test('nothing newer than the read time does not', () => {
    expect(shouldOfferRecap(minutesAgo(20), minutesAgo(25), NOW, CREATED)).toBe(false);
    expect(shouldOfferRecap(minutesAgo(20), minutesAgo(20), NOW, CREATED)).toBe(false);
  });

  test('a thread never read counts from its creation time', () => {
    expect(shouldOfferRecap(null, minutesAgo(1), NOW, CREATED)).toBe(true);
    expect(shouldOfferRecap(undefined, minutesAgo(1), NOW, minutesAgo(3))).toBe(false);
  });

  test('exactly 5 minutes away is enough', () => {
    expect(shouldOfferRecap(minutesAgo(5), minutesAgo(1), NOW, CREATED)).toBe(true);
  });

  test('no activity or unparseable times offer nothing', () => {
    expect(shouldOfferRecap(minutesAgo(20), null, NOW, CREATED)).toBe(false);
    expect(shouldOfferRecap('garbage', minutesAgo(1), NOW, null)).toBe(false);
  });
});

describe('canShowRecap', () => {
  test('the owner of a local or worktree thread gets a recap', () => {
    expect(canShowRecap({ userId: 'u1', runtime: 'local' }, 'u1')).toBe(true);
    expect(canShowRecap({ userId: 'u1' }, 'u1')).toBe(true);
  });

  test('a non-owner or steer sharee gets none', () => {
    expect(canShowRecap({ userId: 'u1', runtime: 'local' }, 'u2')).toBe(false);
    const steerShared = { userId: 'u1', runtime: 'local', viewerShareLevel: 'steer' as const };
    expect(canShowRecap(steerShared, 'u2')).toBe(false);
    expect(canShowRecap({ userId: 'u1' }, null)).toBe(false);
    expect(canShowRecap(null, 'u1')).toBe(false);
  });

  test('a sandbox thread gets none, even for its owner', () => {
    expect(canShowRecap({ userId: 'u1', runtime: 'sandbox' }, 'u1')).toBe(false);
  });
});
