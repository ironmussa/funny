/**
 * Reviewer agent — automated code review for GitHub PRs.
 *
 * V1: Single-pass analysis. Fetch PR diff → LLM review → post findings.
 */

export { PRReviewer } from './reviewer.js';
export { buildReviewSystemPrompt, buildReviewUserPrompt } from './prompts.js';
export { formatReviewBody, decideReviewEvent } from './formatter.js';
export type {
  ReviewOptions,
  PRReviewerConfig,
  ParsedReviewOutput,
  ParsedFinding,
} from './types.js';
