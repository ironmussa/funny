/**
 * Security H3: attachments served on the server origin are sandboxed even after
 * the global `secureHeaders` CSP replaced whatever the proxy set.
 */
import { describe, expect, test } from 'bun:test';

import { sandboxAttachmentResponse } from '../../lib/runner-content-policy.js';

const GLOBAL_CSP = "default-src 'self'; script-src 'self'";

describe('sandboxAttachmentResponse', () => {
  test('appends sandbox to the global CSP of an attachment', () => {
    const headers = new Headers({
      'Content-Disposition': 'attachment',
      'Content-Security-Policy': GLOBAL_CSP,
    });
    sandboxAttachmentResponse(headers);
    expect(headers.get('Content-Security-Policy')).toBe(`${GLOBAL_CSP}; sandbox`);
  });

  test('sets sandbox when there is no CSP and never duplicates it', () => {
    const headers = new Headers({ 'Content-Disposition': 'attachment; filename="a.html"' });
    sandboxAttachmentResponse(headers);
    expect(headers.get('Content-Security-Policy')).toBe('sandbox');
    sandboxAttachmentResponse(headers);
    expect(headers.get('Content-Security-Policy')).toBe('sandbox');
  });

  test('leaves inline and dispositionless responses alone', () => {
    for (const disposition of ['inline; filename="a.png"', null]) {
      const headers = new Headers({ 'Content-Security-Policy': GLOBAL_CSP });
      if (disposition) headers.set('Content-Disposition', disposition);
      sandboxAttachmentResponse(headers);
      expect(headers.get('Content-Security-Policy')).toBe(GLOBAL_CSP);
    }
  });
});
