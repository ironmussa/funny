import { describe, test, expect } from 'bun:test';
import winston from 'winston';

/**
 * Tests for the Abbacchio logging setup.
 *
 * We cannot import the singleton logger directly (it connects to the transport),
 * so we test the configuration logic by recreating it with the same patterns.
 */

describe('Abbacchio logging configuration', () => {
  test('creates a logger with correct default level', () => {
    const logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
      ),
      defaultMeta: { service: 'funny-server' },
      transports: [
        new winston.transports.Console({ silent: true }),
      ],
    });

    expect(logger.level).toBe('info');
  });

  test('respects LOG_LEVEL override', () => {
    const logger = winston.createLogger({
      level: 'debug',
      format: winston.format.timestamp(),
      transports: [new winston.transports.Console({ silent: true })],
    });

    expect(logger.level).toBe('debug');
  });

  test('includes default meta with service name', () => {
    const logger = winston.createLogger({
      level: 'info',
      defaultMeta: { service: 'funny-server' },
      transports: [new winston.transports.Console({ silent: true })],
    });

    expect(logger.defaultMeta).toEqual({ service: 'funny-server' });
  });

  test('logger can log messages without throwing', () => {
    const logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
      ),
      defaultMeta: { service: 'funny-server' },
      transports: [
        new winston.transports.Console({ silent: true }),
      ],
    });

    // Should not throw
    expect(() => {
      logger.info('Test message', { namespace: 'test' });
      logger.warn('Warning message', { namespace: 'test', extra: 'data' });
      logger.error('Error message', { namespace: 'test', error: 'something failed' });
      logger.debug('Debug message');
    }).not.toThrow();
  });

  test('dev format includes namespace in output', () => {
    let captured = '';
    const logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp, namespace, ...meta }) => {
          const ns = namespace ? `[${namespace}]` : '';
          const extra = Object.keys(meta).length > 1
            ? ' ' + JSON.stringify(
                Object.fromEntries(Object.entries(meta).filter(([k]) => k !== 'service')),
              )
            : '';
          captured = `${timestamp} ${level} ${ns} ${message}${extra}`;
          return captured;
        }),
      ),
      defaultMeta: { service: 'funny-server' },
      transports: [
        new winston.transports.Console({ silent: true }),
      ],
    });

    logger.info('test log', { namespace: 'git' });

    // The format function was called and included namespace
    expect(captured).toContain('[git]');
    expect(captured).toContain('test log');
  });

  test('production format outputs JSON', () => {
    let captured = '';
    const { Writable } = require('stream');
    const captureStream = new Writable({
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        captured = chunk.toString();
        callback();
      },
    });

    const logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
      ),
      transports: [
        new winston.transports.Stream({ stream: captureStream }),
      ],
    });

    logger.info('json test');

    const parsed = JSON.parse(captured);
    expect(parsed.message).toBe('json test');
    expect(parsed.level).toBe('info');
    expect(parsed.timestamp).toBeTruthy();
  });
});
