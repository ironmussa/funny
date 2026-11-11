/**
 * The process a background `funny_run_checks` job runs:
 * `bun run-cli.ts <spec.json>`, where the spec holds the plan and its
 * progress file. It follows the run like the synchronous tool does and prints
 * ONLY the summary, so the job's log tail, which wakes the agent, is the same
 * answer a synchronous call would have returned. Exits with the run's code.
 *
 * Bundled as its own entry (`dist/run-cli.js`) by `build.ts`.
 */

import { readFileSync } from 'node:fs';

import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

import { runCheck } from './runner.js';
import { summarizeCheckRun } from './summary.js';
import type { CheckPlan } from './toolchain.js';

// Written by check-tool.ts for this run from a plan it built, so the plan is
// taken as is; only its envelope is checked.
const specSchema = z.object({
  plan: z.custom<CheckPlan>((value) => typeof value === 'object' && value !== null),
  progressPath: z.string().min(1),
});

const specPath = process.argv[2];
if (!specPath) {
  process.stderr.write('usage: run-cli <spec.json>\n');
  process.exit(2);
}

const parsed = parseStoredJson(specSchema, readFileSync(specPath, 'utf8'), 'check spec');
if (!parsed.ok) {
  process.stderr.write(`${parsed.error}\n`);
  process.exit(2);
}
const spec = parsed.value;
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => controller.abort());
}
const result = await runCheck(spec.plan, {
  progressPath: spec.progressPath,
  signal: controller.signal,
});
process.stdout.write(`${summarizeCheckRun(spec.plan, result, spec.progressPath)}\n`);
process.exit(result.exitCode);
