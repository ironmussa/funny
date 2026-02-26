import { describe, test, expect } from 'bun:test';

import {
  notFound,
  badRequest,
  forbidden,
  validationErr,
  processError,
  conflict,
  internal,
  type DomainError,
  type DomainErrorType,
} from '../errors.js';

// ── Simple factory functions ────────────────────────────────────

describe('notFound', () => {
  test('returns a NOT_FOUND error with the given message', () => {
    const err = notFound('Thread not found');
    expect(err).toEqual({ type: 'NOT_FOUND', message: 'Thread not found' });
  });

  test('type discriminant is NOT_FOUND', () => {
    expect(notFound('x').type).toBe('NOT_FOUND');
  });
});

describe('badRequest', () => {
  test('returns a BAD_REQUEST error with the given message', () => {
    const err = badRequest('Missing required field');
    expect(err).toEqual({ type: 'BAD_REQUEST', message: 'Missing required field' });
  });

  test('type discriminant is BAD_REQUEST', () => {
    expect(badRequest('y').type).toBe('BAD_REQUEST');
  });
});

describe('forbidden', () => {
  test('returns a FORBIDDEN error with the given message', () => {
    const err = forbidden('Access denied');
    expect(err).toEqual({ type: 'FORBIDDEN', message: 'Access denied' });
  });

  test('type discriminant is FORBIDDEN', () => {
    expect(forbidden('z').type).toBe('FORBIDDEN');
  });
});

describe('validationErr', () => {
  test('returns a VALIDATION error with the given message', () => {
    const err = validationErr('Invalid email format');
    expect(err).toEqual({ type: 'VALIDATION', message: 'Invalid email format' });
  });

  test('type discriminant is VALIDATION', () => {
    expect(validationErr('v').type).toBe('VALIDATION');
  });
});

describe('conflict', () => {
  test('returns a CONFLICT error with the given message', () => {
    const err = conflict('Branch already exists');
    expect(err).toEqual({ type: 'CONFLICT', message: 'Branch already exists' });
  });

  test('type discriminant is CONFLICT', () => {
    expect(conflict('c').type).toBe('CONFLICT');
  });
});

describe('internal', () => {
  test('returns an INTERNAL error with the given message', () => {
    const err = internal('Unexpected failure');
    expect(err).toEqual({ type: 'INTERNAL', message: 'Unexpected failure' });
  });

  test('type discriminant is INTERNAL', () => {
    expect(internal('i').type).toBe('INTERNAL');
  });
});

// ── processError (has optional fields) ──────────────────────────

describe('processError', () => {
  test('returns a PROCESS_ERROR with only a message', () => {
    const err = processError('git failed');
    expect(err.type).toBe('PROCESS_ERROR');
    expect(err.message).toBe('git failed');
  });

  test('includes exitCode when provided', () => {
    const err = processError('git failed', 128);
    expect(err).toEqual({
      type: 'PROCESS_ERROR',
      message: 'git failed',
      exitCode: 128,
      stderr: undefined,
    });
  });

  test('includes stderr when provided', () => {
    const err = processError('git failed', 1, 'fatal: not a git repository');
    expect(err).toEqual({
      type: 'PROCESS_ERROR',
      message: 'git failed',
      exitCode: 1,
      stderr: 'fatal: not a git repository',
    });
  });

  test('exitCode and stderr are undefined when omitted', () => {
    const err = processError('oops') as Extract<DomainError, { type: 'PROCESS_ERROR' }>;
    expect(err.exitCode).toBeUndefined();
    expect(err.stderr).toBeUndefined();
  });

  test('exitCode can be 0', () => {
    const err = processError('completed with warnings', 0);
    expect(err).toEqual({
      type: 'PROCESS_ERROR',
      message: 'completed with warnings',
      exitCode: 0,
      stderr: undefined,
    });
  });

  test('stderr can be an empty string', () => {
    const err = processError('failed', 1, '');
    expect(err).toEqual({
      type: 'PROCESS_ERROR',
      message: 'failed',
      exitCode: 1,
      stderr: '',
    });
  });
});

// ── General properties ──────────────────────────────────────────

describe('general factory properties', () => {
  test('every factory returns a plain object (not a class instance)', () => {
    const errors = [
      notFound('a'),
      badRequest('b'),
      forbidden('c'),
      validationErr('d'),
      processError('e'),
      conflict('f'),
      internal('g'),
    ];
    for (const err of errors) {
      expect(Object.getPrototypeOf(err)).toBe(Object.prototype);
    }
  });

  test('each factory produces a distinct type discriminant', () => {
    const types: DomainErrorType[] = [
      notFound('').type,
      badRequest('').type,
      forbidden('').type,
      validationErr('').type,
      processError('').type,
      conflict('').type,
      internal('').type,
    ];
    const unique = new Set(types);
    expect(unique.size).toBe(7);
  });

  test('message can contain special characters', () => {
    const msg = 'Error: "value" has <html> & special chars \n\ttabs';
    expect(notFound(msg).message).toBe(msg);
    expect(processError(msg, 1, msg).message).toBe(msg);
  });

  test('message can be an empty string', () => {
    expect(notFound('').message).toBe('');
    expect(badRequest('').message).toBe('');
    expect(internal('').message).toBe('');
  });
});
