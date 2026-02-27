/**
 * @funny/reviewbot — Automated code review for GitHub PRs.
 *
 * V1: Single-pass analysis. Fetch PR diff → LLM review → post findings.
 */

export { PRReviewer } from './reviewer.js';
export { buildReviewSystemPrompt, buildReviewUserPrompt } from './prompts.js';
export { formatReviewBody, decideReviewEvent } from './formatter.js';
export { handlePRWebhook, parseRepoMappings } from './webhook-handler.js';
export type { PRWebhookPayload, RepoMapping, WebhookHandlerOptions } from './webhook-handler.js';
export type {
  ReviewOptions,
  PRReviewerConfig,
  ParsedReviewOutput,
  ParsedFinding,
} from './types.js';
