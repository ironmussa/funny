/**
 * Security H1 — per-runner keys. A key derived for runner A must not sign or
 * verify for runner B, and must never equal (or reveal) the root secret.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import {
  __resetForwardedIdentityNonceCacheForTests,
  signForwardedIdentity,
  verifyForwardedIdentity,
} from '../../auth/forwarded-identity.js';
import { buildSignedMediaUrl, verifyMediaUrl } from '../../auth/media-url-signature.js';
import { deriveRunnerForwardingKey, deriveRunnerMediaKey } from '../../auth/runner-keys.js';

const ROOT = 'root-secret-0123456789abcdef0123456789abcdef';
const identity = { userId: 'admin-user', role: 'admin', orgId: null, orgName: null };

describe('per-runner forwarding keys', () => {
  beforeEach(() => __resetForwardedIdentityNonceCacheForTests());

  test('derivation is deterministic, per-runner, and never the root secret', () => {
    const a = deriveRunnerForwardingKey(ROOT, 'runner-a');
    expect(deriveRunnerForwardingKey(ROOT, 'runner-a')).toBe(a);
    expect(deriveRunnerForwardingKey(ROOT, 'runner-b')).not.toBe(a);
    expect(deriveRunnerForwardingKey('another-root', 'runner-a')).not.toBe(a);
    expect(a).not.toBe(ROOT);
    expect(a).not.toContain(ROOT);
  });

  test('refuses empty inputs', () => {
    expect(() => deriveRunnerForwardingKey('', 'runner-a')).toThrow();
    expect(() => deriveRunnerForwardingKey(ROOT, '')).toThrow();
    expect(() => deriveRunnerMediaKey('')).toThrow();
  });

  test("runner A's key cannot mint a forwarded identity that runner B accepts", () => {
    const keyA = deriveRunnerForwardingKey(ROOT, 'runner-a');
    const keyB = deriveRunnerForwardingKey(ROOT, 'runner-b');
    const forged = signForwardedIdentity(identity, keyA);
    expect(
      verifyForwardedIdentity(identity, keyB, forged.signature, forged.timestamp, forged.nonce),
    ).toBe(false);
  });

  test("the server's signature for runner B verifies only with B's key", () => {
    const keyA = deriveRunnerForwardingKey(ROOT, 'runner-a');
    const keyB = deriveRunnerForwardingKey(ROOT, 'runner-b');
    const forB = signForwardedIdentity(identity, deriveRunnerForwardingKey(ROOT, 'runner-b'));
    expect(
      verifyForwardedIdentity(identity, keyA, forB.signature, forB.timestamp, forB.nonce),
    ).toBe(false);
    expect(
      verifyForwardedIdentity(identity, keyB, forB.signature, forB.timestamp, forB.nonce),
    ).toBe(true);
  });

  test("a signature made with the root secret is not accepted under a runner's key", () => {
    const keyA = deriveRunnerForwardingKey(ROOT, 'runner-a');
    const legacy = signForwardedIdentity(identity, ROOT);
    expect(
      verifyForwardedIdentity(identity, keyA, legacy.signature, legacy.timestamp, legacy.nonce),
    ).toBe(false);
  });

  test('media URLs signed for runner A do not verify on runner B', () => {
    const mediaA = deriveRunnerMediaKey(deriveRunnerForwardingKey(ROOT, 'runner-a'));
    const mediaB = deriveRunnerMediaKey(deriveRunnerForwardingKey(ROOT, 'runner-b'));
    expect(mediaA).not.toBe(deriveRunnerForwardingKey(ROOT, 'runner-a'));
    const claim = { path: '/home/u/p/out.png', userId: 'user-1', expires: Date.now() + 60_000 };
    const url = new URL(buildSignedMediaUrl('https://runner-a.example', claim, mediaA));
    const params = {
      path: url.searchParams.get('path'),
      userId: url.searchParams.get('u'),
      expires: url.searchParams.get('exp'),
      signature: url.searchParams.get('sig'),
    };
    expect(verifyMediaUrl(params, mediaA).ok).toBe(true);
    expect(verifyMediaUrl(params, mediaB)).toEqual({ ok: false, reason: 'bad-signature' });
  });
});
