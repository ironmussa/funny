/**
 * The runner operations a user calls, for both `/api/runners` (REST) and the
 * `runners` tRPC router. A user reaches only their own runners (an instance
 * admin reaches every runner); anyone else's answers 404 and is audited, so its
 * existence is not disclosed. What a runner calls with its own credential
 * (register, enrollment start / poll, heartbeat, tasks, its own record) stays
 * in routes/runners.ts.
 */

import { failure, type RunnerCaller, type RunnersPort } from '@funny/api';
import { err, ok } from 'neverthrow';

import { audit } from '../../lib/audit.js';
import * as enroll from '../../services/runner-enrollment-service.js';
import * as rm from '../../services/runner-manager.js';

const runnerNotFound = () => err(failure(404, 'Runner not found'));

/** The owner or an admin; anyone else is refused and audited. */
async function canAccessRunner(
  { userId, role }: RunnerCaller,
  runnerId: string,
  operation: string,
): Promise<boolean> {
  if (role === 'admin') return true;
  const ownerId = await rm.getRunnerUserId(runnerId);
  if (ownerId === userId) return true;
  audit({
    action: 'authz.cross_tenant_refused',
    actorId: userId,
    detail: 'Runner access refused — non-owner',
    meta: { runnerId, ownerId: ownerId ?? null, operation },
  });
  return false;
}

export const runnersPort: RunnersPort = {
  async list({ userId, role }) {
    return ok({
      runners: role === 'admin' ? await rm.listRunners() : await rm.listRunnersByUser(userId),
    });
  },

  async remove({ userId, role }, runnerId) {
    if (role === 'admin') {
      await rm.removeRunner(runnerId);
    } else if (!(await rm.removeRunnerForUser(runnerId, userId))) {
      return err(failure(404, 'Runner not found or not owned by you'));
    }
    audit({
      action: 'runner.remove',
      actorId: userId,
      detail: role === 'admin' ? 'Admin removed runner' : 'User removed own runner',
      meta: { runnerId },
    });
    return ok({ ok: true as const });
  },

  async assignments(caller, runnerId) {
    if (!(await rm.getRunner(runnerId)) || !(await canAccessRunner(caller, runnerId, 'list'))) {
      return runnerNotFound();
    }
    return ok({ assignments: await rm.listAssignments(runnerId) });
  },

  async assignProject(caller, runnerId, data) {
    if (!(await rm.getRunner(runnerId)) || !(await canAccessRunner(caller, runnerId, 'assign'))) {
      return runnerNotFound();
    }
    return ok(await rm.assignProject(runnerId, data));
  },

  async unassignProject(caller, runnerId, projectId) {
    if (!(await rm.getRunner(runnerId)) || !(await canAccessRunner(caller, runnerId, 'unassign'))) {
      return runnerNotFound();
    }
    await rm.unassignProject(runnerId, { projectId });
    return ok({ ok: true as const });
  },

  async enrollment(userCode) {
    const info = await enroll.getByUserCode(userCode);
    return info ? ok(info) : err(failure(404, 'Unknown or expired code'));
  },

  async approveEnrollment(userId, userCode) {
    const result = await enroll.approve(userCode, userId);
    if (!result.ok) {
      audit({
        action: 'runner.enroll_rejected',
        actorId: userId,
        detail: `Runner enrollment approval failed: ${result.reason}`,
        meta: { reason: result.reason },
      });
      const status = result.reason === 'already_approved' ? 409 : 404;
      return err({ ...failure(status, `Enrollment ${result.reason}`), code: result.reason });
    }
    audit({
      action: 'runner.enroll_approved',
      actorId: userId,
      detail: 'Runner enrollment approved',
      meta: { runnerId: result.runnerId },
    });
    return ok({ ok: true as const, runnerId: result.runnerId });
  },
};
