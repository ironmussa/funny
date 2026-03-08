/**
 * @domain subdomain: Pipeline
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: agent:completed
 *
 * Listens for agent:completed events and advances the pipeline
 * when the completed agent is part of a pipeline run.
 *
 * Two cases:
 * 1. Reviewer completed → parse verdict, decide pass/fail/fix
 * 2. Corrector completed → apply patch, commit, re-review
 */

import { log } from '../../lib/logger.js';
import {
  getRunsForThread,
  getRunForCorrectorThread,
  handleReviewerCompleted,
  handleCorrectorCompleted,
} from '../pipeline-orchestrator.js';
import type { EventHandler } from './types.js';

export const pipelineCompletedHandler: EventHandler<'agent:completed'> = {
  name: 'pipeline:advance-on-agent-completed',
  event: 'agent:completed',

  action: async (event) => {
    const { threadId, userId, projectId, cwd } = event;

    // Case 1: Check if this thread has an active pipeline run (reviewer completed)
    const runs = getRunsForThread(threadId);
    const activeRun = runs.find((r) => r.status === 'reviewing' && r.currentStage === 'reviewer');

    if (activeRun) {
      log.info('Pipeline: reviewer agent completed', {
        namespace: 'pipeline',
        runId: activeRun.id,
        threadId,
      });

      await handleReviewerCompleted(activeRun.id, threadId, userId, projectId, cwd);
      return;
    }

    // Case 2: Check if this is a corrector thread
    const correctorRunId = getRunForCorrectorThread(threadId);
    if (correctorRunId) {
      log.info('Pipeline: corrector agent completed', {
        namespace: 'pipeline',
        runId: correctorRunId,
        threadId,
      });

      await handleCorrectorCompleted(correctorRunId, threadId, userId, projectId);
      return;
    }

    // Not a pipeline-related completion — ignore
  },
};
