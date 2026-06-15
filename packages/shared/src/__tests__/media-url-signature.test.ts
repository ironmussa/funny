import { describe, test, expect } from 'bun:test';

import {
  MEDIA_SIG_PARAMS,
  buildSignedMediaUrl,
  signMediaClaim,
  verifyMediaUrl,
} from '../auth/media-url-signature.js';

const SECRET = 'test-shared-secret';
const NOW = 1_900_000_000_000; // fixed clock for deterministic expiry checks

function validClaim(overrides: Partial<{ path: string; userId: string; expires: number }> = {}) {
  return {
    path: '/home/u/project/out.png',
    userId: 'user-1',
    expires: NOW + 60_000,
    ...overrides,
  };
}

describe('media URL signing', () => {
  test('a freshly signed URL verifies and yields the original claim', () => {
    const claim = validClaim();
    const url = buildSignedMediaUrl('https://runner.example', claim, SECRET);
    const u = new URL(url);

    expect(u.pathname).toBe('/api/files/raw-signed');
    const res = verifyMediaUrl(
      {
        path: u.searchParams.get(MEDIA_SIG_PARAMS.path),
        userId: u.searchParams.get(MEDIA_SIG_PARAMS.userId),
        expires: u.searchParams.get(MEDIA_SIG_PARAMS.expires),
        signature: u.searchParams.get(MEDIA_SIG_PARAMS.signature),
      },
      SECRET,
      NOW,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claim.path).toBe(claim.path);
      expect(res.claim.userId).toBe(claim.userId);
      expect(res.claim.expires).toBe(claim.expires);
    }
  });

  test('buildSignedMediaUrl strips a trailing slash on the base', () => {
    const url = buildSignedMediaUrl('https://runner.example/', validClaim(), SECRET);
    expect(url.startsWith('https://runner.example/api/files/raw-signed?')).toBe(true);
  });

  test('rejects an expired token', () => {
    const claim = validClaim({ expires: NOW - 1 });
    const sig = signMediaClaim(claim, SECRET);
    const res = verifyMediaUrl(
      { path: claim.path, userId: claim.userId, expires: claim.expires, signature: sig },
      SECRET,
      NOW,
    );
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  test('rejects a tampered path (signature no longer matches)', () => {
    const claim = validClaim();
    const sig = signMediaClaim(claim, SECRET);
    const res = verifyMediaUrl(
      { path: '/etc/passwd', userId: claim.userId, expires: claim.expires, signature: sig },
      SECRET,
      NOW,
    );
    expect(res).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('rejects a tampered userId (cannot swap identity)', () => {
    const claim = validClaim();
    const sig = signMediaClaim(claim, SECRET);
    const res = verifyMediaUrl(
      { path: claim.path, userId: 'attacker', expires: claim.expires, signature: sig },
      SECRET,
      NOW,
    );
    expect(res).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('rejects an extended expiry (exp is part of the signed payload)', () => {
    const claim = validClaim();
    const sig = signMediaClaim(claim, SECRET);
    const res = verifyMediaUrl(
      {
        path: claim.path,
        userId: claim.userId,
        expires: claim.expires + 10_000_000,
        signature: sig,
      },
      SECRET,
      NOW,
    );
    expect(res).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('rejects a signature minted with a different secret', () => {
    const claim = validClaim();
    const sig = signMediaClaim(claim, 'some-other-secret');
    const res = verifyMediaUrl(
      { path: claim.path, userId: claim.userId, expires: claim.expires, signature: sig },
      SECRET,
      NOW,
    );
    expect(res).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('rejects missing parameters', () => {
    expect(
      verifyMediaUrl({ path: null, userId: 'u', expires: NOW, signature: 'x' }, SECRET, NOW),
    ).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(
      verifyMediaUrl({ path: '/p', userId: 'u', expires: NOW, signature: null }, SECRET, NOW),
    ).toEqual({ ok: false, reason: 'missing' });
    expect(
      verifyMediaUrl(
        { path: '/p', userId: 'u', expires: 'not-a-number', signature: 'x' },
        SECRET,
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'missing' });
  });

  test('accepts expires passed as a string (URL query form)', () => {
    const claim = validClaim();
    const sig = signMediaClaim(claim, SECRET);
    const res = verifyMediaUrl(
      { path: claim.path, userId: claim.userId, expires: String(claim.expires), signature: sig },
      SECRET,
      NOW,
    );
    expect(res.ok).toBe(true);
  });
});
