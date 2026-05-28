/**
 * Tests for the SSRF guard. Verifies private/loopback/link-local destinations
 * are rejected for both IP literals and resolved hostnames.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'dns/promises';

import { assertSafeOutboundUrl, safeFetchUserUrl } from '../../lib/ssrf-guard.js';

const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;

describe('assertSafeOutboundUrl', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  afterEach(() => {
    mockLookup.mockReset();
  });

  test('rejects malformed URLs', async () => {
    await expect(assertSafeOutboundUrl('not-a-url')).rejects.toThrow(/Invalid URL/);
  });

  test('rejects non-http(s) schemes', async () => {
    await expect(assertSafeOutboundUrl('ftp://example.com')).rejects.toThrow(/non-http\(s\)/);
    await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toThrow(/non-http\(s\)/);
  });

  test('rejects URLs with embedded credentials', async () => {
    await expect(assertSafeOutboundUrl('https://user:pw@example.com')).rejects.toThrow(
      /embedded credentials/,
    );
  });

  test('rejects loopback IPv4 literal', async () => {
    await expect(assertSafeOutboundUrl('http://127.0.0.1/x')).rejects.toThrow(/private\/loopback/);
  });

  test('rejects AWS metadata IP', async () => {
    // After HI-5: the 169.254/16 range is now classified more specifically
    // as `cloud-metadata/link-local` so the reason wording changed. The
    // expectation here only checks that the IP is refused — the reason
    // message stays human-readable and may evolve.
    await expect(assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /cloud-metadata|link-local|Refusing/,
    );
  });

  test('rejects RFC1918 ranges', async () => {
    await expect(assertSafeOutboundUrl('http://10.0.0.5')).rejects.toThrow(/private\/loopback/);
    await expect(assertSafeOutboundUrl('http://172.16.5.5')).rejects.toThrow(/private\/loopback/);
    await expect(assertSafeOutboundUrl('http://192.168.1.1')).rejects.toThrow(/private\/loopback/);
  });

  test('rejects IPv6 loopback', async () => {
    await expect(assertSafeOutboundUrl('http://[::1]/x')).rejects.toThrow(/private\/loopback/);
  });

  test('rejects hostname that resolves to private IP', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertSafeOutboundUrl('https://internal.example.com')).rejects.toThrow(
      /resolves to private/,
    );
  });

  test('rejects hostname where ANY record is private (mixed result)', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(assertSafeOutboundUrl('https://mixed.example.com')).rejects.toThrow(
      /resolves to private/,
    );
  });

  test('allows hostname that resolves to public IP', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    await expect(assertSafeOutboundUrl('https://public.example.com')).resolves.toBeUndefined();
  });

  test('allows public IPv4 literal', async () => {
    await expect(assertSafeOutboundUrl('https://8.8.8.8/x')).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Security HI-5 — safeFetchUserUrl & cloud-metadata policy
// ─────────────────────────────────────────────────────────────

describe('assertSafeOutboundUrl with LAN-OK policy (rejectPrivate=false)', () => {
  test('still blocks cloud-metadata IPv4 (169.254.169.254)', async () => {
    await expect(
      assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data/', {
        rejectPrivate: false,
      }),
    ).rejects.toThrow(/cloud-metadata|link-local/);
  });

  test('still blocks 0.0.0.0/8 (this-network IMDS alias)', async () => {
    await expect(
      assertSafeOutboundUrl('http://0.0.0.0/x', { rejectPrivate: false }),
    ).rejects.toThrow(/cloud-metadata|this-network|link-local/);
  });

  test('still blocks fe80:: IPv6 link-local', async () => {
    await expect(
      assertSafeOutboundUrl('http://[fe80::1]/x', { rejectPrivate: false }),
    ).rejects.toThrow(/link-local/);
  });

  test('allows loopback IPv4 (legit LAN launcher)', async () => {
    await expect(
      assertSafeOutboundUrl('http://127.0.0.1:8080/x', { rejectPrivate: false }),
    ).resolves.toBeUndefined();
  });

  test('allows RFC1918 IPv4 (legit LAN launcher)', async () => {
    await expect(
      assertSafeOutboundUrl('http://192.168.1.50:8080/x', { rejectPrivate: false }),
    ).resolves.toBeUndefined();
  });
});

describe('safeFetchUserUrl (security HI-5)', () => {
  test('blocks IMDS even though the helper allows RFC1918', async () => {
    // No `mockLookup` call — IMDS is checked against the literal IP, no DNS needed.
    await expect(safeFetchUserUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /cloud-metadata|link-local/,
    );
  });

  test('refuses non-http(s) schemes', async () => {
    await expect(safeFetchUserUrl('ftp://example.com/x')).rejects.toThrow(/non-http/);
  });

  test('refuses URLs with embedded credentials', async () => {
    await expect(safeFetchUserUrl('http://user:pw@example.com/x')).rejects.toThrow(
      /embedded credentials/,
    );
  });

  // We deliberately skip the success-case round trip — that would attempt a
  // real fetch against the destination. The guard's contract is "validate
  // then delegate to fetch", and the validation behaviour is covered above.
});
