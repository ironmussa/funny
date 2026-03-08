/**
 * @domain subdomain: Pipeline
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: git:committed
 *
 * Listens for git:committed events and starts a pipeline review
 * if the project has an enabled pipeline configured.
 */

import { log } from '../../lib/logger.js';
import { getPipelineForProject, startReview } from '../pipeline-orchestrator.js';
import type { EventHandler } from './types.js';

export const pipelineTriggerHandler: EventHandler<'git:committed'> = {
  name: 'pipeline:trigger-on-commit',
  event: 'git:committed',

  action: async (event) => {
    const { threadId, userId, projectId, cwd, commitSha, isPipelineCommit, pipelineRunId } = event;

    const pipeline = getPipelineForProject(projectId);
    if (!pipeline) return; // No pipeline configured for this project

    log.info('Pipeline trigger: git:committed received', {
      namespace: 'pipeline',
      threadId,
      commitSha,
      isPipelineCommit,
      pipelineRunId,
    });

    await startReview({
      pipeline,
      threadId,
      userId,
      projectId,
      commitSha,
      cwd,
      isPipelineCommit,
      pipelineRunId,
    });
  },
};
