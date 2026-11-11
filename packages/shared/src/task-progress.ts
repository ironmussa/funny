/**
 * Live progress of a task made of steps (lint, typecheck, build, …), as a JSON
 * file a step runner rewrites while it runs and the client's `task-progress`
 * visualizer polls. The test-specific counterpart is `test-progress.ts`.
 *
 * Producer: `scripts/run-steps.ts` when `FUNNY_TASK_PROGRESS` names the file.
 * Consumer: the built-in visualizer for ` ```task-progress ` fences, whose body
 * is `{ "path": "<absolute path>" }`. Any other runner can write the same shape.
 */
import { z } from 'zod';

import { parseStoredJson, type JsonValidationResult } from './json-validation.js';

export const TASK_PROGRESS_VERSION = 1;

/** Issues kept in the file; the counts on each step stay exact. */
export const TASK_ISSUE_LIMIT = 50;

const stepStatus = z.enum(['queued', 'running', 'passed', 'failed']);

const taskStepSchema = z.object({
  /** The command it runs, e.g. `fitness:layering`. */
  id: z.string(),
  name: z.string(),
  status: stepStatus,
  /** Epoch milliseconds. */
  startedAt: z.number().optional(),
  durationMs: z.number().optional(),
  errors: z.number().int().nonnegative().default(0),
  warnings: z.number().int().nonnegative().default(0),
  /** Sub-units (e.g. typecheck projects) finished and in total, when reported. */
  unitsDone: z.number().int().nonnegative().optional(),
  unitsTotal: z.number().int().nonnegative().optional(),
  /** What the step reported last (a project, a file, a check). */
  current: z.string().optional(),
  /** Last output lines of a failed step that reported no issue of its own. */
  tail: z.array(z.string()).default([]),
});

const taskIssueSchema = z.object({
  step: z.string(),
  severity: z.enum(['error', 'warning']),
  file: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  message: z.string(),
});

export const taskProgressSchema = z.object({
  version: z.literal(TASK_PROGRESS_VERSION),
  /** What is running, e.g. `lint`. */
  title: z.string(),
  status: z.enum(['running', 'passed', 'failed']),
  /** Epoch milliseconds. */
  startedAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().optional(),
  /** Steps the runner runs at once. */
  concurrency: z.number().int().positive().optional(),
  steps: z.array(taskStepSchema),
  /** Errors first, at most `TASK_ISSUE_LIMIT`. */
  issues: z.array(taskIssueSchema).default([]),
});

export type TaskProgress = z.infer<typeof taskProgressSchema>;
export type TaskStep = z.infer<typeof taskStepSchema>;
export type TaskStepStatus = z.infer<typeof stepStatus>;
export type TaskIssue = z.infer<typeof taskIssueSchema>;

export function parseTaskProgress(raw: string): JsonValidationResult<TaskProgress> {
  return parseStoredJson(taskProgressSchema, raw, 'task progress');
}
