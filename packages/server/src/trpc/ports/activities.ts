/**
 * The caller's background activities (track-background-activities, design D6)
 * for the `activities` tRPC router. Rows are written by the runner through the
 * data channel or by the server itself; here the user only reads and removes
 * their own.
 */

import { failure, type ActivitiesPort } from '@funny/api';
import { err, ok } from 'neverthrow';

import { repos } from '../../db/repos.js';
import { broadcastActivitiesRemoved } from '../../services/activities/activity-service.js';
import type { RunnerPresencePort } from '../../services/runner-ports.js';

/** How long a `running` server-run activity is protected from dismissal. */
const SERVER_ROW_STALE_MS = 30 * 60_000;

export function createActivitiesPort(
  presence?: Pick<RunnerPresencePort, 'isAvailable'>,
  now: () => number = Date.now,
) {
  /**
   * Whether the row is still being run. A server row (no runner) is run by this
   * server, which interrupts its own leftovers at start (track-funny-actions,
   * design D7); one still `running` after `SERVER_ROW_STALE_MS` is taken as
   * stuck (a hung provider call) and can be dismissed. Without a presence port
   * a runner is assumed connected: refusing is the safe side.
   */
  const stillRunning = async (row: { runnerId: string | null; startedAt: string }) => {
    if (row.runnerId === null) {
      return now() - Date.parse(row.startedAt) < SERVER_ROW_STALE_MS;
    }
    return presence ? presence.isAvailable(row.runnerId) : true;
  };

  const port: ActivitiesPort = {
    async list(userId) {
      return ok(await repos.activities().listByUser(userId));
    },

    async dismiss(userId, id) {
      const row = await repos.activities().getById(id);
      if (!row || row.userId !== userId) return err(failure(404, 'Not found'));
      if (row.status === 'running' && (await stillRunning(row))) {
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
