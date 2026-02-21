/**
 * Hatchet worker — registers all workflows and starts processing.
 *
 * Only starts if HATCHET_CLIENT_TOKEN is set in the environment.
 * Gracefully skips when Hatchet is not configured.
 */

import { getHatchetClient, isHatchetEnabled } from './client.js';
import { registerFeatureToDeployWorkflow } from './workflows/feature-to-deploy.js';
import { registerCleanupWorkflow } from './workflows/cleanup.js';
import { registerDocGardeningWorkflow } from './workflows/doc-gardening.js';
import { registerPRReviewLoopWorkflow } from './workflows/pr-review-loop.js';
import { logger } from '../infrastructure/logger.js';

/**
 * Start the Hatchet worker with all registered workflows.
 * No-op if HATCHET_CLIENT_TOKEN is not set.
 */
export async function startHatchetWorker(): Promise<void> {
  if (!isHatchetEnabled()) {
    logger.info('HATCHET_CLIENT_TOKEN not set — Hatchet worker disabled');
    return;
  }

  const hatchet = getHatchetClient();

  const featureWorkflow = registerFeatureToDeployWorkflow(hatchet);
  const cleanupWorkflow = registerCleanupWorkflow(hatchet);
  const docGardeningWorkflow = registerDocGardeningWorkflow(hatchet);
  const prReviewLoopWorkflow = registerPRReviewLoopWorkflow(hatchet);

  const worker = await hatchet.worker('pipeline-worker', {
    workflows: [featureWorkflow, cleanupWorkflow, docGardeningWorkflow, prReviewLoopWorkflow],
  });

  await worker.start();
  logger.info('Hatchet worker started with workflows: feature-to-deploy, cleanup, doc-gardening, pr-review-loop');
}
