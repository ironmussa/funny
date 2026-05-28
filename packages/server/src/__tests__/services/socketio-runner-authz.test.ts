import { describe, test, expect } from 'bun:test';

import {
  extractRunnerEventUserId,
  isRunnerEventAllowed,
} from '../../services/socketio-runner-authz.js';

describe('socketio-runner-authz', () => {
  describe('extractRunnerEventUserId', () => {
    test('returns string userId from object payloads', () => {
      expect(extractRunnerEventUserId({ userId: 'user-a' })).toBe('user-a');
    });

    test('returns undefined for missing or invalid payloads', () => {
      expect(extractRunnerEventUserId(null)).toBeUndefined();
      expect(extractRunnerEventUserId([])).toBeUndefined();
      expect(extractRunnerEventUserId({ userId: 123 })).toBeUndefined();
      expect(extractRunnerEventUserId({})).toBeUndefined();
    });
  });

  describe('isRunnerEventAllowed', () => {
    test('allows events without an explicit target user', () => {
      expect(isRunnerEventAllowed(null, undefined)).toBe(true);
      expect(isRunnerEventAllowed('user-a', undefined)).toBe(true);
    });

    test('allows matching runner owner and target user', () => {
      expect(isRunnerEventAllowed('user-a', 'user-a')).toBe(true);
    });

    test('denies cross-tenant targets', () => {
      expect(isRunnerEventAllowed('user-a', 'user-b')).toBe(false);
    });

    test('denies user-scoped events from ownerless legacy runners', () => {
      expect(isRunnerEventAllowed(null, 'user-a')).toBe(false);
    });
  });
});
