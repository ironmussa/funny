/**
 * Tests for the standalone console logger.
 */

import { describe, expect, test } from 'bun:test';

import { createConsoleLogger } from '../logger.js';

function captureStreams<T>(fn: () => T): { stdout: string[]; stderr: string[]; result: T } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = fn();
    return { stdout, stderr, result };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
}

describe('createConsoleLogger', () => {
  test('text format prints level + msg + key=value pairs', () => {
    const logger = createConsoleLogger({ format: 'text', level: 'info' });
    const { stdout } = captureStreams(() => {
      logger.info('hello', { namespace: 'ns', count: 3 });
    });
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain('[info] hello');
    expect(stdout[0]).toContain('namespace=ns');
    expect(stdout[0]).toContain('count=3');
  });

  test('json format outputs ndjson', () => {
    const logger = createConsoleLogger({ format: 'json', level: 'info' });
    const { stdout } = captureStreams(() => {
      logger.info('hello', { namespace: 'ns', x: 1 });
    });
    const parsed = JSON.parse(stdout[0].trimEnd());
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.namespace).toBe('ns');
    expect(parsed.x).toBe(1);
    expect(typeof parsed.ts).toBe('string');
  });

  test('warn and error go to stderr', () => {
    const logger = createConsoleLogger({ level: 'info' });
    const { stdout, stderr } = captureStreams(() => {
      logger.info('a');
      logger.warn('b');
      logger.error('c');
    });
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(2);
  });

  test('level filter drops below-threshold logs', () => {
    const logger = createConsoleLogger({ level: 'warn' });
    const { stdout, stderr } = captureStreams(() => {
      logger.info('skipped');
      logger.warn('kept');
    });
    expect(stdout).toHaveLength(0);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('kept');
  });

  test('text format quotes values containing spaces', () => {
    const logger = createConsoleLogger({ format: 'text', level: 'info' });
    const { stdout } = captureStreams(() => {
      logger.info('m', { detail: 'has spaces' });
    });
    expect(stdout[0]).toContain('detail="has spaces"');
  });
});
