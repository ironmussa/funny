/**
 * Security ME-8 regression — Socket.IO browser-namespace Origin allowlist.
 *
 * The full Socket.IO server isn't trivially mockable here, so we extracted
 * the Origin check into a pure predicate (`isAllowedBrowserOrigin`). These
 * tests pin the gate's behaviour; the integration is straight string
 * equality so the predicate IS the surface.
 */
import { describe, expect, test } from 'bun:test';

import { isAllowedBrowserOrigin } from '../../services/socketio.js';

const ALLOWED = ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://app.example.com'];

describe('isAllowedBrowserOrigin (security ME-8)', () => {
  test('admits an Origin in the allowlist', () => {
    expect(isAllowedBrowserOrigin('http://localhost:5173', ALLOWED)).toBe(true);
    expect(isAllowedBrowserOrigin('http://127.0.0.1:5173', ALLOWED)).toBe(true);
    expect(isAllowedBrowserOrigin('https://app.example.com', ALLOWED)).toBe(true);
  });

  test('rejects undefined / empty Origin (non-browser callers)', () => {
    expect(isAllowedBrowserOrigin(undefined, ALLOWED)).toBe(false);
    expect(isAllowedBrowserOrigin('', ALLOWED)).toBe(false);
  });

  test('rejects an attacker Origin not in the allowlist', () => {
    expect(isAllowedBrowserOrigin('https://attacker.example.com', ALLOWED)).toBe(false);
    expect(isAllowedBrowserOrigin('http://localhost:1234', ALLOWED)).toBe(false);
  });

  test('rejects an exact case mismatch — Origin comparison is case-sensitive', () => {
    expect(isAllowedBrowserOrigin('HTTP://LOCALHOST:5173', ALLOWED)).toBe(false);
  });

  test('rejects subdomain confusion — must be exact host:port match', () => {
    const allowed = ['https://app.example.com'];
    expect(isAllowedBrowserOrigin('https://app.example.com.attacker.com', allowed)).toBe(false);
    expect(isAllowedBrowserOrigin('https://evilapp.example.com', allowed)).toBe(false);
  });

  test('rejects trailing-slash variants', () => {
    // Real WS upgrade Origins never have a trailing path; if the operator
    // mistakenly puts one in the allowlist it should not normalise.
    expect(isAllowedBrowserOrigin('http://localhost:5173/', ALLOWED)).toBe(false);
  });

  test('empty allowlist rejects every Origin', () => {
    expect(isAllowedBrowserOrigin('http://localhost:5173', [])).toBe(false);
    expect(isAllowedBrowserOrigin('https://anywhere.example', [])).toBe(false);
  });
});
