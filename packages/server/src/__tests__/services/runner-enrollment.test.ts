/**
 * Tests for device-link runner enrollment — the service logic and the HTTP
 * routes, plus the forwarded-identity delivery regression.
 *
 * Without the fix the dishonest classic flow forced operators to hand-carry a
 * shared secret; device-link instead delivers it (and the bearer) only after a
 * logged-in user approves the runner. These tests pin that contract:
 *   - start issues a code + token; poll stays pending until approved
 *   - approve binds the runner to the approver and is single-use
 *   - poll delivers credentials exactly once, then the enrollment is consumed
 *   - the delivered forwardedSecret matches the server secret and round-trips
 *     through forwarded-identity sign/verify
 */

// Must be set before the service/routes read it (forwardedSecret source).
process.env.RUNNER_AUTH_SECRET = 'test-shared-secret';

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import {
  signForwardedIdentity,
  verifyForwardedIdentity,
  __resetForwardedIdentityNonceCacheForTests,
} from '@funny/shared/auth/forwarded-identity';

import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('Runner Enrollment (device-link)', () => {
  let t: TestApp;
  let enroll: typeof import('../../services/runner-enrollment-service.js');

  beforeAll(async () => {
    t = await createTestApp();
    enroll = await import('../../services/runner-enrollment-service.js');
  });

  beforeEach(() => {
    t.cleanup();
  });

  // ── Service ────────────────────────────────────────────

  describe('service', () => {
    test('startEnrollment issues a user code and poll token; poll is pending', async () => {
      const started = await enroll.startEnrollment({
        hostname: 'box.local',
        os: 'linux',
        ip: '10.0.0.1',
      });
      expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(started.pollToken).toMatch(/^rpt_/);
      expect(started.expiresIn).toBeGreaterThan(0);

      const poll = await enroll.pollByToken(started.pollToken);
      expect(poll.status).toBe('pending');
    });

    test('getByUserCode returns metadata for a pending enrollment', async () => {
      const started = await enroll.startEnrollment({
        hostname: 'box.local',
        os: 'darwin',
        ip: '10.0.0.2',
      });
      const info = await enroll.getByUserCode(started.userCode);
      expect(info).not.toBeNull();
      expect(info!.hostname).toBe('box.local');
      expect(info!.os).toBe('darwin');
      expect(info!.ip).toBe('10.0.0.2');
    });

    test('approve binds a runner to the approver and poll delivers creds once', async () => {
      const started = await enroll.startEnrollment({
        hostname: 'box.local',
        os: 'linux',
        ip: '10.0.0.3',
      });

      const result = await enroll.approve(started.userCode, 'user-approver');
      expect(result.ok).toBe(true);

      // The runner is now owned by the approver.
      const runners = await t.requestAs('user-approver').get('/api/runners');
      const body = await runners.json();
      expect(body.runners).toHaveLength(1);
      expect(body.runners[0].hostname).toBe('box.local');

      // First poll after approval delivers the credentials + secret.
      const poll1 = await enroll.pollByToken(started.pollToken);
      expect(poll1.status).toBe('approved');
      if (poll1.status === 'approved') {
        expect(poll1.token).toMatch(/^runner_/);
        expect(poll1.forwardedSecret).toBe('test-shared-secret');
      }

      // Second poll must NOT re-issue (consumed).
      const poll2 = await enroll.pollByToken(started.pollToken);
      expect(poll2.status).toBe('invalid');
    });

    test('approving an unknown code fails; a code cannot be approved twice', async () => {
      const miss = await enroll.approve('ZZZZ-ZZZZ', 'user-1');
      expect(miss).toEqual({ ok: false, reason: 'not_found' });

      const started = await enroll.startEnrollment({
        hostname: 'h',
        os: 'linux',
        ip: '',
      });
      const first = await enroll.approve(started.userCode, 'user-1');
      expect(first.ok).toBe(true);
      const second = await enroll.approve(started.userCode, 'user-1');
      expect(second).toEqual({ ok: false, reason: 'already_approved' });
    });

    test('an invalid poll token is rejected', async () => {
      const poll = await enroll.pollByToken('rpt_does-not-exist');
      expect(poll.status).toBe('invalid');
    });

    test('delivered forwardedSecret round-trips through forwarded-identity', async () => {
      __resetForwardedIdentityNonceCacheForTests();
      const started = await enroll.startEnrollment({ hostname: 'h', os: 'linux', ip: '' });
      await enroll.approve(started.userCode, 'user-1');
      const poll = await enroll.pollByToken(started.pollToken);
      expect(poll.status).toBe('approved');
      if (poll.status !== 'approved') return;

      // The server signs proxied identity with its secret; the runner verifies
      // with the delivered one. They must match for proxied requests to work.
      const identity = { userId: 'user-1', role: 'user', orgId: null, orgName: null };
      const sig = signForwardedIdentity(identity, process.env.RUNNER_AUTH_SECRET!);
      const ok = verifyForwardedIdentity(
        identity,
        poll.forwardedSecret,
        sig.signature,
        sig.timestamp,
        sig.nonce,
      );
      expect(ok).toBe(true);
    });
  });

  // ── Routes ─────────────────────────────────────────────

  describe('routes', () => {
    test('POST /enroll/start → 201 with code + token', async () => {
      const res = await t.requestAs('anon').post('/api/runners/enroll/start', {
        hostname: 'box.local',
        os: 'linux',
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.userCode).toBeTruthy();
      expect(body.pollToken).toBeTruthy();
    });

    test('POST /enroll/start → 400 when fields missing', async () => {
      const res = await t.requestAs('anon').post('/api/runners/enroll/start', { hostname: 'x' });
      expect(res.status).toBe(400);
    });

    test('full flow: start → metadata → approve → poll delivers creds', async () => {
      const start = await t
        .requestAs('anon')
        .post('/api/runners/enroll/start', { hostname: 'box.local', os: 'linux' });
      const { userCode, pollToken } = await start.json();

      // Pending before approval.
      const pendingPoll = await t.requestAs('anon').post('/api/runners/enroll/poll', { pollToken });
      expect((await pendingPoll.json()).status).toBe('pending');

      // Metadata lookup (authenticated).
      const meta = await t.requestAs('user-1').get(`/api/runners/enroll/${userCode}`);
      expect(meta.status).toBe(200);
      expect((await meta.json()).hostname).toBe('box.local');

      // Approve (authenticated).
      const approve = await t.requestAs('user-1').post('/api/runners/enroll/approve', { userCode });
      expect(approve.status).toBe(200);

      // Poll now delivers credentials.
      const poll = await t.requestAs('anon').post('/api/runners/enroll/poll', { pollToken });
      const pollBody = await poll.json();
      expect(pollBody.status).toBe('approved');
      expect(pollBody.token).toMatch(/^runner_/);
      expect(pollBody.forwardedSecret).toBe('test-shared-secret');
    });

    test('POST /enroll/poll → 404 for unknown token', async () => {
      const res = await t
        .requestAs('anon')
        .post('/api/runners/enroll/poll', { pollToken: 'rpt_nope' });
      expect(res.status).toBe(404);
    });

    test('GET /enroll/:userCode → 404 for unknown code', async () => {
      const res = await t.requestAs('user-1').get('/api/runners/enroll/ZZZZ-ZZZZ');
      expect(res.status).toBe(404);
    });

    test('POST /enroll/approve → 409 when already approved', async () => {
      const start = await t
        .requestAs('anon')
        .post('/api/runners/enroll/start', { hostname: 'box.local', os: 'linux' });
      const { userCode } = await start.json();
      await t.requestAs('user-1').post('/api/runners/enroll/approve', { userCode });
      const again = await t.requestAs('user-1').post('/api/runners/enroll/approve', { userCode });
      expect(again.status).toBe(409);
    });
  });
});
