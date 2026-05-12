/**
 * Tests for the standalone console logger.
 */

import { describe, expect, test } from 'bun:test';

import { createConsoleLogger } from '../logger.js';

function captureConsole<T>(fn: () => T): { logs: string[]; errors: string[]; result: T } {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg: unknown) => {
    logs.push(String(msg));
  };
  console.error = (msg: unknown) => {
    errors.push(String(msg));
  };
  try {
    const result = fn();
    return { logs, errors, result };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe('createConsoleLogger', () => {
  test('text format prints level + msg + key=value pairs', () => {
    const logger = createConsoleLogger({ format: 'text', level: 'info' });
    const { logs } = captureConsole(() => {
      logger.info('hello', { namespace: 'ns', count: 3 });
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[info] hello');
    expect(logs[0]).toContain('namespace=ns');
    expect(logs[0]).toContain('count=3');
  });

  test('json format outputs ndjson', () => {
    const logger = createConsoleLogger({ format: 'json', level: 'info' });
    const { logs } = captureConsole(() => {
      logger.info('hello', { namespace: 'ns', x: 1 });
    });
    const parsed = JSON.parse(logs[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.namespace).toBe('ns');
    expect(parsed.x).toBe(1);
    expect(typeof parsed.ts).toBe('string');
  });

  test('warn and error go to stderr', () => {
    const logger = createConsoleLogger({ level: 'info' });
    const { logs, errors } = captureConsole(() => {
      logger.info('a');
      logger.warn('b');
      logger.error('c');
    });
    expect(logs).toHaveLength(1);
    expect(errors).toHaveLength(2);
  });

  test('level filter drops below-threshold logs', () => {
    const logger = createConsoleLogger({ level: 'warn' });
    const { logs, errors } = captureConsole(() => {
      logger.info('skipped');
      logger.warn('kept');
    });
    expect(logs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('kept');
  });

  test('text format quotes values containing spaces', () => {
    const logger = createConsoleLogger({ format: 'text', level: 'info' });
    const { logs } = captureConsole(() => {
      logger.info('m', { detail: 'has spaces' });
    });
    expect(logs[0]).toContain('detail="has spaces"');
  });
});
