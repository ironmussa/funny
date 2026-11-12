/**
 * Which of the owner's runners serve one project (project-runner-binding), for
 * the `projectRunners` tRPC router. Only the project OWNER may read or change it
 * (404 for anyone else). Every write goes through the runner-scope writers,
 * and a runner that loses access has the project's running agents stopped;
 * its files stay on disk.
 *
 * Built per request: stopping agents needs the request's runner ports.
 */

import { failure, type ProjectRunnersPort } from '@funny/api';
import { and, eq, inArray } from 'drizzle-orm';
import { err, ok } from 'neverthrow';

import { db } from '../../db/index.js';
import { threads } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import * as projectRepo from '../../services/project-repository.js';
import {
  authorizedRunnerRequests,
  runnerActor,
  withRunnerFor,
} from '../../services/runner-access/index.js';
import { listRunnersByUser } from '../../services/runner-manager.js';
import type { RunnerPresencePort, RunnerRequestPort } from '../../services/runner-ports.js';
import {
  getGeneralRunnerId,
  getProjectRunnerSettings,
  grantProjectRunner,
  revokeProjectRunner,
  setGeneralRunner,
  setProjectDedicatedRunner,
  setProjectGithubToken,
} from '../../services/runner-scope.js';

type RunnerPorts = { requests?: RunnerRequestPort; presence?: RunnerPresencePort };

const ACTIVE_STATUSES = ['running', 'waiting', 'pending'];

/**
 * Stop the project's active agents on runners that just lost access.
 *
 * The identity signed into each stop is the PROJECT OWNER's, read from the
 * project row (never from the request). Each runner is certified for
 * ownership only (`owned-runner`): it has just lost project scope, so a
 * project-scoped certification would refuse the very cleanup we need. A
 * runner that is not the owner's is skipped and audited by `runner-access`.
 */
export async function stopProjectSessionsOnRunners(
  ports: RunnerPorts,
  projectId: string,
  runnerIds: string[],
): Promise<void> {
  if (!ports.requests || runnerIds.length === 0) return;
  const project = await projectRepo.getProject(projectId);
  if (!project) return;
  const owner = runnerActor({ userId: project.userId });
  const sink = authorizedRunnerRequests(ports.requests);
  const active = await db
    .select({ id: threads.id, runnerId: threads.runnerId })
    .from(threads)
    .where(
      and(
        eq(threads.projectId, projectId),
        inArray(threads.runnerId, runnerIds),
        inArray(threads.status, ACTIVE_STATUSES),
      ),
    );
  for (const t of active) {
    if (!t.runnerId) continue;
    const result = await withRunnerFor(
      owner,
      { kind: 'owned-runner', runnerId: t.runnerId },
      ports.presence,
      async (actor, runner, proof) => {
        if (!(await sink.isAvailable(runner))) return;
        try {
          await sink.send(actor, runner, proof, {
            method: 'POST',
            path: `/api/threads/${t.id}/stop`,
            headers: { 'Content-Type': 'application/json' },
            body: null,
          });
        } catch (e) {
          log.warn('Failed to stop thread on revoked runner', {
            namespace: 'project-runner-settings',
            projectId,
            runnerId: runner.value,
            threadId: t.id,
            error: (e as Error).message,
          });
        }
      },
    );
    if (result.isErr()) {
      log.warn('Skipped stopping thread on a runner the project owner does not own', {
        namespace: 'project-runner-settings',
        projectId,
        runnerId: t.runnerId,
        threadId: t.id,
      });
    }
  }
}

const projectNotFound = () => err(failure(404, 'Project not found'));
const runnerNotFound = () => err(failure(404, 'Runner not found'));

async function isProjectOwner(projectId: string, userId: string): Promise<boolean> {
  const project = await projectRepo.getProject(projectId);
  return !!project && project.userId === userId;
}

async function currentSettings(projectId: string) {
  const settings = await getProjectRunnerSettings(projectId);
  return settings ? ok(settings) : projectNotFound();
}

export function createProjectRunnersPort(ports: RunnerPorts): ProjectRunnersPort {
  return {
    async settings(userId, projectId) {
      if (!(await isProjectOwner(projectId, userId))) return projectNotFound();
      const settings = await getProjectRunnerSettings(projectId);
      if (!settings) return projectNotFound();
      return ok({
        ...settings,
        generalRunnerId: await getGeneralRunnerId(userId),
        runners: await listRunnersByUser(userId),
      });
    },

    async update(userId, projectId, { dedicatedRunnerId, githubToken }) {
      if (!(await isProjectOwner(projectId, userId))) return projectNotFound();
      if (dedicatedRunnerId !== undefined) {
        const result = await setProjectDedicatedRunner(projectId, userId, dedicatedRunnerId);
        if (!result.ok) return runnerNotFound();
        audit({
          action: 'project.runner_binding_changed',
          actorId: userId,
          detail: `project ${projectId} dedicated runner → ${dedicatedRunnerId ?? 'general'}`,
          meta: { projectId, dedicatedRunnerId, revoked: result.revokedRunnerIds },
        });
        await stopProjectSessionsOnRunners(ports, projectId, result.revokedRunnerIds);
      }
      if (githubToken !== undefined) await setProjectGithubToken(projectId, githubToken);
      return currentSettings(projectId);
    },

    async grant(userId, projectId, runnerId) {
      if (!(await isProjectOwner(projectId, userId))) return projectNotFound();
      if (!(await grantProjectRunner(projectId, userId, runnerId))) return runnerNotFound();
      return currentSettings(projectId);
    },

    async revoke(userId, projectId, runnerId) {
      if (!(await isProjectOwner(projectId, userId))) return projectNotFound();
      const result = await revokeProjectRunner(projectId, userId, runnerId);
      if (!result.ok) return projectNotFound();
      if (result.lostAccess) await stopProjectSessionsOnRunners(ports, projectId, [runnerId]);
      return currentSettings(projectId);
    },

    async setGeneralRunner(userId, runnerId) {
      if (!(await setGeneralRunner(userId, runnerId))) return runnerNotFound();
      return ok({ generalRunnerId: runnerId });
    },
  };
}
