/**
 * Tests for the runner-side device-link enrollment client and the credentials
 * persistence that makes a restart transparent.
 *
 * The enrollment loop must: start, poll until approved, and return the
 * delivered credentials (bearer + forwarded-identity secret). The credentials
 * file must round-trip the forwardedSecret so a restart re-loads it without
 * re-enrolling.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { loadRunnerCredentials, saveRunnerCredentials } from '../../services/runner-credentials.js';
import { enrollRunner } from '../../services/runner-enrollment.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('runner-enrollment client', () => {
  const originalFetch = global.fetch;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    stdoutSpy.mockRestore();
    global.fetch = originalFetch;
  });

  test('starts, polls until approved, returns delivered credentials', async () => {
    let pollCount = 0;
    global.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/api/runners/enroll/start')) {
        return jsonResponse(201, {
          userCode: 'WXYZ-1234',
          pollToken: 'rpt_test',
          expiresIn: 900,
          interval: 1,
        });
      }
      if (url.endsWith('/api/runners/enroll/poll')) {
        pollCount++;
        if (pollCount < 2) return jsonResponse(200, { status: 'pending' });
        return jsonResponse(200, {
          status: 'approved',
          runnerId: 'runner-abc',
          token: 'runner_secrettoken',
          forwardedSecret: 'shared-secret',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const promise = enrollRunner('http://server.test');
    // Drive the internal sleeps (two 1s poll intervals) to completion.
    await vi.advanceTimersByTimeAsync(5000);
    const creds = await promise;

    expect(creds).toEqual({
      runnerId: 'runner-abc',
      token: 'runner_secrettoken',
      forwardedSecret: 'shared-secret',
    });
    expect(pollCount).toBe(2);
    // The user code was surfaced to the operator.
    const printed = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(printed).toContain('WXYZ-1234');
  });

  test('restarts enrollment with a fresh code when one expires (404)', async () => {
    let startCount = 0;
    global.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/api/runners/enroll/start')) {
        startCount++;
        return jsonResponse(201, {
          userCode: startCount === 1 ? 'AAAA-1111' : 'BBBB-2222',
          pollToken: `rpt_${startCount}`,
          expiresIn: 900,
          interval: 1,
        });
      }
      if (url.endsWith('/api/runners/enroll/poll')) {
        // First enrollment expires (404); second is approved.
        if (startCount === 1) return new Response('expired', { status: 404 });
        return jsonResponse(200, {
          status: 'approved',
          runnerId: 'runner-xyz',
          token: 'runner_tok',
          forwardedSecret: 's',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const promise = enrollRunner('http://server.test');
    await vi.advanceTimersByTimeAsync(5000);
    const creds = await promise;

    expect(creds.runnerId).toBe('runner-xyz');
    expect(startCount).toBe(2);
  });
});

describe('runner-credentials persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'funny-creds-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips the forwardedSecret so a restart resumes', () => {
    saveRunnerCredentials(
      {
        serverUrl: 'http://server.test',
        runnerId: 'r1',
        token: 'runner_tok',
        forwardedSecret: 'shared-secret',
      },
      dir,
    );

    const loaded = loadRunnerCredentials('http://server.test', dir);
    expect(loaded).toEqual({
      serverUrl: 'http://server.test',
      runnerId: 'r1',
      token: 'runner_tok',
      forwardedSecret: 'shared-secret',
    });
  });

  test('credentials for a different server are ignored', () => {
    saveRunnerCredentials({ serverUrl: 'http://a.test', runnerId: 'r1', token: 'runner_tok' }, dir);
    expect(loadRunnerCredentials('http://b.test', dir)).toBeNull();
  });
});
