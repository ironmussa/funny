import { describe, expect, it } from 'bun:test';
import { createHmac } from 'crypto';

import { verifyGitHubSignature } from '../standalone.js';

describe('standalone webhook signature verification', () => {
  it('accepts a valid GitHub sha256 signature', () => {
    const body = JSON.stringify({ action: 'opened', number: 1 });
    const secret = 'test-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    expect(verifyGitHubSignature(body, signature, secret)).toBe(true);
  });

  it('rejects raw secret values and mismatched signatures', () => {
    const body = JSON.stringify({ action: 'opened', number: 1 });
    const secret = 'test-secret';

    expect(verifyGitHubSignature(body, secret, secret)).toBe(false);
    expect(verifyGitHubSignature(body, 'sha256=bad', secret)).toBe(false);
  });
});
