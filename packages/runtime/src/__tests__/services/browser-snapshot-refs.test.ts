import { describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));

import { extractRefs, RefGenerations } from '../../services/browser-automation/snapshot-refs.js';
import {
  parseChromeMajor,
  regularChromeUserAgent,
} from '../../services/browser-automation/user-agent.js';

const SNAP_1 = `- textbox "Email" [ref=e4]\n- button "Go" [ref=e5]`;
const SNAP_2 = `- heading "Done" [level=1] [ref=e2]`;

describe('RefGenerations', () => {
  test('extracts refs from an AI snapshot', () => {
    expect([...extractRefs(SNAP_1)]).toEqual(['e4', 'e5']);
  });

  test('refs are unusable before any snapshot', () => {
    expect(new RefGenerations().check('e1')).toEqual({ ok: false, reason: 'no-snapshot' });
  });

  test('refs from the latest snapshot are valid', () => {
    const refs = new RefGenerations();
    refs.recordSnapshot(SNAP_1);
    expect(refs.check('e5')).toEqual({ ok: true });
  });

  test('navigation invalidates refs', () => {
    const refs = new RefGenerations();
    refs.recordSnapshot(SNAP_1);
    refs.invalidate('navigation');
    expect(refs.check('e5')).toEqual({ ok: false, reason: 'navigation' });
  });

  test('a newer snapshot invalidates refs only in the older one', () => {
    const refs = new RefGenerations();
    refs.recordSnapshot(SNAP_1);
    refs.recordSnapshot(SNAP_2);
    expect(refs.check('e5')).toEqual({ ok: false, reason: 'snapshot' });
    expect(refs.check('e2')).toEqual({ ok: true });
  });

  test('control change invalidates refs', () => {
    const refs = new RefGenerations();
    refs.recordSnapshot(SNAP_1);
    refs.invalidate('control');
    expect(refs.check('e4')).toEqual({ ok: false, reason: 'control' });
  });
});

describe('regular Chrome user agent', () => {
  test('parses the major from --version output', () => {
    expect(parseChromeMajor('Chromium 149.0.7827.0')).toBe(149);
    expect(parseChromeMajor('Google Chrome 131.0.6778.85 ')).toBe(131);
    expect(parseChromeMajor('garbage')).toBeNull();
  });

  test('builds a reduced UA without HeadlessChrome', () => {
    const ua = regularChromeUserAgent(149, 'linux');
    expect(ua).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    );
  });
});

describe('agent URL normalisation', () => {
  test('adds a scheme to bare hosts', async () => {
    const { normalizeUrl } = await import('../../services/browser-automation/browser-tools.js');
    expect(normalizeUrl('dash.cloudflare.com')).toBe('https://dash.cloudflare.com/');
    expect(normalizeUrl('localhost:5173/app')).toBe('http://localhost:5173/app');
    expect(normalizeUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });

  test('refuses schemes that reach local resources or OS handlers', async () => {
    const { normalizeUrl } = await import('../../services/browser-automation/browser-tools.js');
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'chrome://settings',
      'apt:firefox',
    ]) {
      expect(() => normalizeUrl(url)).toThrow(/Only http\(s\)/);
    }
  });
});
