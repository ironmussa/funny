/**
 * Live progress of a test run, as a JSON file a test runner rewrites while it
 * runs and the client's `test-progress` visualizer polls.
 *
 * Producer: `scripts/run-tests.ts` (and the pre-push hook) when
 * `FUNNY_TEST_PROGRESS` names the file. Consumer: the built-in visualizer for
 * ` ```test-progress ` fences, whose body is `{ "path": "<absolute path>" }`.
 * Any other runner can write the same shape.
 */
import { z } from 'zod';

import { parseStoredJson, type JsonValidationResult } from './json-validation.js';

export const TEST_PROGRESS_VERSION = 1;

const suiteStatus = z.enum(['queued', 'running', 'passed', 'failed']);

/** A test file running now. */
const runningFileSchema = z.object({
  file: z.string(),
  /** Epoch milliseconds. */
  startedAt: z.number(),
});

/** A file or test that took at least `SLOW_TEST_MS`. */
const slowEntrySchema = z.object({
  kind: z.enum(['file', 'test']),
  name: z.string(),
  durationMs: z.number(),
});

/** Files and tests at least this slow are listed for monitoring. */
export const SLOW_TEST_MS = 10_000;

const testProgressSuiteSchema = z.object({
  name: z.string(),
  status: suiteStatus,
  /** Ran only the tests related to the changed files (`vitest related`). */
  related: z.boolean().default(false),
  /** Epoch milliseconds. */
  startedAt: z.number().optional(),
  durationMs: z.number().optional(),
  passed: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
  /** Test file (or test) the suite reported last. */
  current: z.string().optional(),
  /** Test files in the run and finished so far, when the runner reports them. */
  filesTotal: z.number().int().nonnegative().optional(),
  filesDone: z.number().int().nonnegative().optional(),
  running: z.array(runningFileSchema).default([]),
  /** Slowest first. */
  slow: z.array(slowEntrySchema).default([]),
});

/** Run-level fields every live progress file has (`test-progress`, `task-progress`). */
export const progressRunFields = {
  status: z.enum(['running', 'passed', 'failed']),
  /** Epoch milliseconds. */
  startedAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().optional(),
  /** Suites (or steps) the runner runs at once. */
  concurrency: z.number().int().positive().optional(),
};

export const testProgressSchema = z.object({
  version: z.literal(TEST_PROGRESS_VERSION),
  ...progressRunFields,
  suites: z.array(testProgressSuiteSchema),
});

export type TestProgress = z.infer<typeof testProgressSchema>;
export type TestProgressSuite = z.infer<typeof testProgressSuiteSchema>;
export type TestProgressSuiteStatus = z.infer<typeof suiteStatus>;
export type TestProgressSlowEntry = z.infer<typeof slowEntrySchema>;

export function parseTestProgress(raw: string): JsonValidationResult<TestProgress> {
  return parseStoredJson(testProgressSchema, raw, 'test progress');
}

/** Body of a ` ```test-progress ` fence: the progress file to follow. */
const testProgressFenceSchema = z.object({ path: z.string().min(1) });

/**
 * The progress file a fence points at. Accepts `{ "path": "…" }` or a bare
 * absolute path; null for anything else.
 */
export function parseTestProgressFence(source: string): string | null {
  const text = source.trim();
  if (text.startsWith('/') && !text.includes('\n')) return text;
  const parsed = parseStoredJson(testProgressFenceSchema, text, 'test-progress fence');
  return parsed.ok ? parsed.value.path : null;
}
