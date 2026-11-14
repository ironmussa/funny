/**
 * What every step shares: the spec fields common to all steps, the run's
 * event file, and the exit marker it leaves for the orchestrator.
 */

import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

import { z } from 'zod';

import { JsonlRunReporter } from '../adapters/jsonl-run-reporter.js';
import type { StepOutcome } from '../domain/step-outcome.js';

/** Spec fields of every step: the run, its branch, how it commits and checks, its files. */
export const stepSpecFields = {
  runId: z.string().min(1),
  base: z.string().min(1),
  branch: z.string().min(1),
  checkCommand: z.string().optional(),
  author: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  model: z.string().min(1),
  eventsPath: z.string().min(1),
  exitMarkerPath: z.string().min(1),
};

export interface StepIo {
  /** Append an event to the run's event file (in the background). */
  report(event_type: string, data: Record<string, unknown>): void;
  /**
   * Report how the step ended, print its session id and write the exit marker
   * last. A broken event file loses the run's history but never its outcome.
   */
  finish<T extends StepOutcome>(
    outcome: T,
    print: (line: string) => void,
    completed?: Record<string, unknown>,
  ): Promise<T>;
}

export function stepIo(
  spec: { runId: string; eventsPath: string; exitMarkerPath: string },
  now: () => Date,
): StepIo {
  const reporter = new JsonlRunReporter(spec.eventsPath);
  const reports: Promise<void>[] = [];
  const report = (event_type: string, data: Record<string, unknown>) => {
    reports.push(
      reporter.report({
        event_type,
        request_id: spec.runId,
        thread_id: spec.runId,
        timestamp: now().toISOString(),
        data,
      }),
    );
  };
  return {
    report,
    async finish(outcome, print, completed = {}) {
      if (outcome.kind === 'failed') {
        report('factory.failed', {
          error: outcome.reason,
          failure_kind: outcome.failure,
          session_id: outcome.sessionId,
        });
      } else {
        report('factory.completed', { ...completed, session_id: outcome.sessionId });
      }
      if (outcome.sessionId) print(`session_id=${outcome.sessionId}`);
      const failed = (await Promise.allSettled(reports)).filter((r) => r.status === 'rejected');
      await writeExitMarker(spec.exitMarkerPath, {
        ...outcome,
        ...(failed.length > 0
          ? { eventFileError: String((failed[0] as PromiseRejectedResult).reason) }
          : {}),
        finishedAt: now().toISOString(),
      });
      return outcome;
    },
  };
}

/** Written last and atomically: its presence means the step has ended. */
async function writeExitMarker(path: string, marker: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
  await rename(temp, path);
}
