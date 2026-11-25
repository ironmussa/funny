import { describe, expect, test } from 'bun:test';

import { userRoleSchema } from '../../lib/types.js';

describe('userRoleSchema', () => {
  test('keeps a known role', () => {
    expect(userRoleSchema.parse('admin')).toBe('admin');
    expect(userRoleSchema.parse('user')).toBe('user');
  });

  test('coerces anything else to the least-privileged role', () => {
    for (const raw of ['Admin', 'owner', '', null, undefined, 1, { role: 'admin' }, ['admin']]) {
      expect(userRoleSchema.parse(raw)).toBe('user');
    }
  });
});
