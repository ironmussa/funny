/**
 * Tests for the SSRF guard. Verifies private/loopback/link-local destinations
 * are rejected for both IP literals and resolved hostnames.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'dns/promises';

import { assertSafeOutboundUrl } from '../../lib/ssrf-guard.js';

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
    await expect(assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /private\/loopback/,
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
