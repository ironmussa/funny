import { describe, test, expect, beforeEach } from 'bun:test';

import {
  SIGNATURE_MAX_SKEW_MS,
  __resetForwardedIdentityNonceCacheForTests,
  signForwardedIdentity,
  verifyForwardedIdentity,
} from '../auth/forwarded-identity.js';

beforeEach(() => __resetForwardedIdentityNonceCacheForTests());

const SECRET = 'super-secret-value-0123456789abcdef';

describe('forwarded-identity', () => {
  test('sign/verify round-trips a full identity', () => {
    const now = 1_700_000_000_000;
    const identity = {
      userId: 'user_1',
      role: 'admin',
      orgId: 'org_9',
      orgName: 'Acme',
    };
    const { signature, timestamp, nonce } = signForwardedIdentity(identity, SECRET, now);
    expect(verifyForwardedIdentity(identity, SECRET, signature, timestamp, nonce, now)).toBe(true);
  });

  test('verify fails when the secret differs', () => {
    const now = 1_700_000_000_000;
    const identity = { userId: 'u', role: 'user', orgId: null, orgName: null };
    const { signature, timestamp, nonce } = signForwardedIdentity(identity, SECRET, now);
    expect(verifyForwardedIdentity(identity, SECRET + 'x', signature, timestamp, nonce, now)).toBe(
      false,
    );
  });

  test('verify fails if any identity field is tampered', () => {
    const now = 1_700_000_000_000;
    const identity = { userId: 'alice', role: 'user', orgId: null, orgName: null };
    const { signature, timestamp, nonce } = signForwardedIdentity(identity, SECRET, now);
    // Attacker swaps userId while keeping the signature.
    expect(
      verifyForwardedIdentity(
        { ...identity, userId: 'admin' },
        SECRET,
        signature,
        timestamp,
        nonce,
        now,
      ),
    ).toBe(false);
    // Attacker escalates role.
    expect(
      verifyForwardedIdentity(
        { ...identity, role: 'admin' },
        SECRET,
        signature,
        timestamp,
        nonce,
        now,
      ),
    ).toBe(false);
  });

  test('verify rejects timestamps outside the skew window', () => {
    const now = 1_700_000_000_000;
    const identity = { userId: 'u', role: 'user', orgId: null, orgName: null };
    const { signature, nonce } = signForwardedIdentity(identity, SECRET, now);
    const staleTs = now - SIGNATURE_MAX_SKEW_MS - 1;
    expect(verifyForwardedIdentity(identity, SECRET, signature, staleTs, nonce, now)).toBe(false);
  });

  test('verify rejects missing signature, timestamp, or nonce', () => {
    const identity = { userId: 'u' };
    const { signature, timestamp, nonce } = signForwardedIdentity(identity, SECRET);
    expect(verifyForwardedIdentity(identity, SECRET, undefined, timestamp, nonce)).toBe(false);
    expect(verifyForwardedIdentity(identity, SECRET, signature, undefined, nonce)).toBe(false);
    expect(verifyForwardedIdentity(identity, SECRET, signature, timestamp, undefined)).toBe(false);
  });

  test('verify rejects a non-hex signature of wrong length', () => {
    const now = 1_700_000_000_000;
    const identity = { userId: 'u' };
    const { nonce } = signForwardedIdentity(identity, SECRET, now);
    expect(verifyForwardedIdentity(identity, SECRET, 'nothex', now, nonce, now)).toBe(false);
  });

  test('SIGNATURE_MAX_SKEW_MS is at most 60 seconds (H3)', () => {
    expect(SIGNATURE_MAX_SKEW_MS).toBeLessThanOrEqual(60 * 1000);
  });

  test('verify rejects an exact replay (same nonce) within the skew window (H3)', () => {
    const now = 1_700_000_000_000;
    const identity = { userId: 'u', role: 'user', orgId: null, orgName: null };
    const { signature, timestamp, nonce } = signForwardedIdentity(identity, SECRET, now);
    // First use succeeds.
    expect(verifyForwardedIdentity(identity, SECRET, signature, timestamp, nonce, now)).toBe(true);
    // Exact replay (same nonce) within window: rejected.
    expect(verifyForwardedIdentity(identity, SECRET, signature, timestamp, nonce, now)).toBe(false);
    // Slightly later (still in window): still rejected.
    expect(verifyForwardedIdentity(identity, SECRET, signature, timestamp, nonce, now + 1000)).toBe(
      false,
    );
  });

  test('a fresh sign+verify still works after a previous replay attempt (H3)', () => {
    const now = 1_700_000_000_000;
    const identity = { userId: 'u' };
    const a = signForwardedIdentity(identity, SECRET, now);
    expect(verifyForwardedIdentity(identity, SECRET, a.signature, a.timestamp, a.nonce, now)).toBe(
      true,
    );
    // Replay: rejected.
    expect(verifyForwardedIdentity(identity, SECRET, a.signature, a.timestamp, a.nonce, now)).toBe(
      false,
    );
    // New signature with a new timestamp: accepted.
    const b = signForwardedIdentity(identity, SECRET, now + 5_000);
    expect(
      verifyForwardedIdentity(identity, SECRET, b.signature, b.timestamp, b.nonce, now + 5_000),
    ).toBe(true);
  });

  test('regression: parallel sign() calls with the same identity + same timestamp produce DISTINCT signatures', () => {
    // Reproduces the browser-refresh false-positive replay: when ~10 requests
    // hit the server proxy in the same millisecond, each must still verify on
    // its own. The per-request nonce makes this work.
    const now = 1_700_000_000_000;
    const identity = { userId: 'u', role: 'admin', orgId: null, orgName: null };
    const signed = Array.from({ length: 10 }, () => signForwardedIdentity(identity, SECRET, now));
    const sigs = new Set(signed.map((s) => s.signature));
    const nonces = new Set(signed.map((s) => s.nonce));
    expect(sigs.size).toBe(10);
    expect(nonces.size).toBe(10);
    // Every one of them verifies.
    for (const { signature, timestamp, nonce } of signed) {
      expect(verifyForwardedIdentity(identity, SECRET, signature, timestamp, nonce, now)).toBe(
        true,
      );
    }
  });

  test('null and undefined identity fields produce the same HMAC (modulo nonce)', () => {
    const now = 1_700_000_000_000;
    const a = signForwardedIdentity({ userId: 'u' }, SECRET, now, 'fixed-nonce');
    const b = signForwardedIdentity(
      { userId: 'u', role: null, orgId: null, orgName: null },
      SECRET,
      now,
      'fixed-nonce',
    );
    expect(a.signature).toBe(b.signature);
  });

  describe('steer-share delegation claim (thread-sharing-steer)', () => {
    test('sign/verify round-trips the steer claim', () => {
      const now = 1_700_000_000_000;
      const identity = {
        userId: 'ana',
        role: 'user',
        orgId: 'org_1',
        orgName: 'Acme',
        shareLevel: 'steer',
        onBehalfOfThread: 't1',
      };
      const { signature, timestamp, nonce } = signForwardedIdentity(identity, SECRET, now);
      expect(verifyForwardedIdentity(identity, SECRET, signature, timestamp, nonce, now)).toBe(
        true,
      );
    });

    test('a request WITHOUT the claim signs the EXACT legacy string (zero back-compat risk)', () => {
      const now = 1_700_000_000_000;
      // Same userId, one with explicit null claim fields, one without — identical
      // to a pre-steer signer. Both must produce the same signature.
      const legacy = signForwardedIdentity({ userId: 'u', role: 'user' }, SECRET, now, 'fixed');
      const withNullClaim = signForwardedIdentity(
        { userId: 'u', role: 'user', shareLevel: null, onBehalfOfThread: null },
        SECRET,
        now,
        'fixed',
      );
      expect(legacy.signature).toBe(withNullClaim.signature);
    });

    test('the claim is bound to the signature — tampering the thread id fails', () => {
      const now = 1_700_000_000_000;
      const identity = {
        userId: 'ana',
        role: 'user',
        orgId: null,
        orgName: null,
        shareLevel: 'steer',
        onBehalfOfThread: 't1',
      };
      const { signature, timestamp, nonce } = signForwardedIdentity(identity, SECRET, now);
      // Attacker re-points the delegation at a different thread.
      expect(
        verifyForwardedIdentity(
          { ...identity, onBehalfOfThread: 't2' },
          SECRET,
          signature,
          timestamp,
          nonce,
          now,
        ),
      ).toBe(false);
      // Attacker can't strip the claim to make a steer request look like an
      // ordinary one either (the signed suffix is missing → HMAC differs).
      expect(
        verifyForwardedIdentity(
          { userId: 'ana', role: 'user', orgId: null, orgName: null },
          SECRET,
          signature,
          timestamp,
          nonce,
          now,
        ),
      ).toBe(false);
    });
  });
});
