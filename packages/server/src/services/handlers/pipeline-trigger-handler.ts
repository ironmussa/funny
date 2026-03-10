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
import { isWorkflowActive } from '../git-workflow-service.js';
import { getPipelineForProject, startPipelineRun } from '../pipeline-orchestrator.js';
import type { EventHandler } from './types.js';

export const pipelineTriggerHandler: EventHandler<'git:committed'> = {
  name: 'pipeline:trigger-on-commit',
  event: 'git:committed',

  action: async (event) => {
    const { threadId, userId, projectId, cwd, commitSha, isPipelineCommit, pipelineRunId } = event;

    const pipeline = await getPipelineForProject(projectId);
    if (!pipeline) return; // No pipeline configured for this project

    // Skip if a commit workflow is already running for this thread/project —
    // the workflow's embedded review-fix sub-pipeline handles the review.
    // This replaces the racy isPipelineCommit event-mutation mechanism:
    // the old approach relied on a listener registered *after* this handler,
    // so isPipelineCommit was always undefined when read here.
    if (isPipelineCommit || isWorkflowActive(threadId) || isWorkflowActive(projectId)) {
      log.info('Pipeline trigger: skipping — workflow active or pipeline commit', {
        namespace: 'pipeline',
        threadId,
        commitSha,
        isPipelineCommit,
        workflowActiveForThread: isWorkflowActive(threadId),
        workflowActiveForProject: isWorkflowActive(projectId),
      });
      return;
    }

    log.info('Pipeline trigger: git:committed received', {
      namespace: 'pipeline',
      threadId,
      commitSha,
    });

    await startPipelineRun({
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
