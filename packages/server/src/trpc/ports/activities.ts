/**
 * The caller's background activities (track-background-activities, design D6)
 * for the `activities` tRPC router. Rows are written by the runner through the
 * data channel; here the user only reads and removes their own.
 */

import { failure, type ActivitiesPort } from '@funny/api';
import { err, ok } from 'neverthrow';

import { repos } from '../../db/repos.js';
import { broadcastActivitiesRemoved } from '../../services/activities/activity-service.js';
import type { RunnerPresencePort } from '../../services/runner-ports.js';

export function createActivitiesPort(presence?: Pick<RunnerPresencePort, 'isAvailable'>) {
  /** Without a presence port the runner is assumed connected: refusing is the safe side. */
  const runnerConnected = async (runnerId: string | null) =>
    runnerId === null ? false : presence ? presence.isAvailable(runnerId) : true;

  const port: ActivitiesPort = {
    async list(userId) {
      return ok(await repos.activities().listByUser(userId));
    },

    async dismiss(userId, id) {
      const row = await repos.activities().getById(id);
      if (!row || row.userId !== userId) return err(failure(404, 'Not found'));
      if (row.status === 'running' && (await runnerConnected(row.runnerId))) {
        return err(failure(409, 'The activity is still running'));
      }
      const removed = await repos.activities().remove(id, userId);
      const ids = removed ? [id] : [];
      broadcastActivitiesRemoved(userId, ids);
      return ok({ ids });
    },

    async clearFinished(userId) {
      const ids = await repos.activities().clearFinished(userId);
      broadcastActivitiesRemoved(userId, ids);
      return ok({ ids });
    },
  };
  return port;
}
