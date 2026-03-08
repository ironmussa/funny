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
  getRunForReviewerThread,
  getRunForCorrectorThread,
  handleReviewerCompleted,
  handleCorrectorCompleted,
} from '../pipeline-orchestrator.js';
import type { EventHandler } from './types.js';

export const pipelineCompletedHandler: EventHandler<'agent:completed'> = {
  name: 'pipeline:advance-on-agent-completed',
  event: 'agent:completed',

  action: async (event) => {
    const { threadId, userId, projectId } = event;

    // Case 1: Check if this is a reviewer worktree thread
    const reviewerRunId = getRunForReviewerThread(threadId);
    if (reviewerRunId) {
      log.info('Pipeline: reviewer agent completed', {
        namespace: 'pipeline',
        runId: reviewerRunId,
        threadId,
      });

      await handleReviewerCompleted(reviewerRunId, threadId, userId, projectId);
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
