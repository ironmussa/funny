import { describe, expect, test } from 'bun:test';

import { contractRiskReason, displayRiskReason } from '../contracts/factory.js';

const PREFIX = 'the contract names a risk: ';
const long = `${'replacing an as T with a parse can reshape input '.repeat(5)}so check each`;

describe('contract risk reasons', () => {
  test('a long note is cut at a word and ends with an ellipsis', () => {
    const hint = contractRiskReason(long).slice(PREFIX.length);
    expect(hint.length).toBeLessThanOrEqual(200);
    expect(hint.endsWith('…')).toBe(true);
    expect(long.startsWith(hint.slice(0, -1))).toBe(true);
    expect(long[hint.length - 1]).toBe(' ');
    expect(contractRiskReason('changes the retry policy')).toBe(
      `${PREFIX}changes the retry policy`,
    );
  });

  test('a reason stored cut mid-word at the limit is shown cut at a word, with an ellipsis', () => {
    const stored = `${PREFIX}${long.slice(0, 200)}`;
    expect(displayRiskReason(stored)).toBe(contractRiskReason(long));
    // Anything else is shown as stored.
    expect(displayRiskReason(contractRiskReason(long))).toBe(contractRiskReason(long));
    expect(displayRiskReason(`${PREFIX}short note`)).toBe(`${PREFIX}short note`);
    expect(displayRiskReason('a test was weakened')).toBe('a test was weakened');
  });
});
