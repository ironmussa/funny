/**
 * Project runner binding settings (project-runner-binding).
 *
 *   GET    /api/projects/:id/runner-settings            — current binding + candidate runners
 *   PUT    /api/projects/:id/runner-settings            — set/clear dedicated runner, git token
 *   POST   /api/projects/:id/runner-grants/:runnerId    — grant an extra runner access
 *   DELETE /api/projects/:id/runner-grants/:runnerId    — revoke it
 *   PUT    /api/projects/general-runner                 — designate the user's general runner
 *
 * They delegate to the project-runners port, which the `projectRunners` tRPC
 * router serves too: only the project OWNER may change which runner serves the
 * project, and a runner that loses access has its running agents for the
 * project stopped.
 */

import {
  setGeneralRunnerBody,
  updateProjectRunnerSettingsBody,
} from '@funny/shared/contracts/runners';
import { Hono, type Context } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { createProjectRunnersPort } from '../trpc/ports/project-runners.js';
import { answerJson } from '../trpc/reply.js';
import { parseJsonBody } from '../validation/request.js';

export const projectRunnerSettingsRoutes = new Hono<ServerEnv>();

const portFor = (c: Context<ServerEnv>) =>
  createProjectRunnersPort({ requests: c.env?.runnerRequests, presence: c.env?.runnerPresence });

projectRunnerSettingsRoutes.put('/general-runner', async (c) => {
  const parsed = await parseJsonBody(c, setGeneralRunnerBody);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(
    c,
    portFor(c).setGeneralRunner(c.get('userId') as string, parsed.value.runnerId),
  );
});

projectRunnerSettingsRoutes.get('/:id/runner-settings', (c) =>
  answerJson(c, portFor(c).settings(c.get('userId') as string, c.req.param('id'))),
);

projectRunnerSettingsRoutes.put('/:id/runner-settings', async (c) => {
  const port = portFor(c);
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');
  // A stranger's project answers 404 before a bad body answers 400.
  const current = await port.settings(userId, projectId);
  if (current.isErr()) return answerJson(c, Promise.resolve(current));
  const parsed = await parseJsonBody(c, updateProjectRunnerSettingsBody);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(c, port.update(userId, projectId, parsed.value));
});

projectRunnerSettingsRoutes.post('/:id/runner-grants/:runnerId', (c) =>
  answerJson(
    c,
    portFor(c).grant(c.get('userId') as string, c.req.param('id'), c.req.param('runnerId')),
  ),
);

projectRunnerSettingsRoutes.delete('/:id/runner-grants/:runnerId', (c) =>
  answerJson(
    c,
    portFor(c).revoke(c.get('userId') as string, c.req.param('id'), c.req.param('runnerId')),
  ),
);
