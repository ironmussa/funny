import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { handleError } from '../../middleware/error-handler.js';

describe('handleError', () => {
  function createApp(errorToThrow: Error) {
    const app = new Hono();
    app.onError(handleError);
    app.get('/test', () => {
      throw errorToThrow;
    });
    return app;
  }

  test('returns 400 with generic message for ProcessExecutionError', async () => {
    const error = new Error('git checkout failed');
    error.name = 'ProcessExecutionError';
    (error as any).command = 'git checkout main';
    (error as any).stderr = 'error: pathspec not found';

    const app = createApp(error);
    const res = await app.request('/test');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Command execution failed' });
  });

  test('returns 500 with generic message for generic Error', async () => {
    const error = new Error('something broke');

    const app = createApp(error);
    const res = await app.request('/test');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
  });

  test('returns 500 with "Internal server error" when error has no message', async () => {
    // Create an Error instance with an empty message
    const error = new Error('');
    error.name = 'WeirdError';

    const app = new Hono();
    app.onError(handleError);
    app.get('/test', () => {
      throw error;
    });

    const res = await app.request('/test');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
  });

  test('returns 400 specifically for ProcessExecutionError by name, not class', async () => {
    // A plain object with name = 'ProcessExecutionError' should also be caught
    const error = new Error('command not found');
    error.name = 'ProcessExecutionError';

    const app = createApp(error);
    const res = await app.request('/test');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Command execution failed' });
  });

  test('returns 500 for TypeError', async () => {
    const error = new TypeError('Cannot read property of undefined');

    const app = createApp(error);
    const res = await app.request('/test');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
  });

  test('returns 500 for RangeError', async () => {
    const error = new RangeError('Maximum call stack size exceeded');

    const app = createApp(error);
    const res = await app.request('/test');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
  });

  test('response body is valid JSON with error key', async () => {
    const error = new Error('test error');
    const app = createApp(error);
    const res = await app.request('/test');

    const body = await res.json();
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
  });

  test('handles error thrown in async route handler', async () => {
    const app = new Hono();
    app.onError(handleError);
    app.get('/test', async () => {
      await Promise.resolve();
      throw new Error('async failure');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
  });
});
