#!/usr/bin/env bun
/**
 * funny-orchestrator-step — runs one step of a factory run inside its
 * workspace (sandbox or worktree). The orchestrator starts it in the
 * workspace's checkout and learns the result from the exit marker.
 *
 *   funny-orchestrator-step implement --spec <spec.json>
 *
 * The spec is `ImplementStepSpec` as JSON. Exit code: 0 when a pull request
 * was opened, 1 when the step failed (see the exit marker), 2 on bad usage.
 */

import { readFile } from 'fs/promises';

import { defaultProcessFactory } from '@funny/core/agents';

import { GhPullRequestOpener } from '../adapters/gh-pull-request-opener.js';
import { implementStepSpecSchema, runImplementStep } from '../steps/implement.js';

const USAGE = 'Usage: funny-orchestrator-step implement --spec <spec.json>';

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const [step, flag, specPath] = process.argv.slice(2);
if (step !== 'implement') fail(step ? `Unknown step: ${step}` : 'Missing step');
if (flag !== '--spec' || !specPath) fail('Missing --spec <spec.json>');

let raw: unknown;
try {
  raw = JSON.parse(await readFile(specPath, 'utf-8'));
} catch (err) {
  fail(`Cannot read ${specPath}: ${err instanceof Error ? err.message : String(err)}`);
}
const spec = implementStepSpecSchema.safeParse(raw);
if (!spec.success) fail(`Invalid spec ${specPath}: ${spec.error.message}`);

const outcome = await runImplementStep(spec.data, {
  cwd: process.cwd(),
  agents: defaultProcessFactory,
  pullRequests: new GhPullRequestOpener(),
  // stdout is the step's protocol with the orchestrator, not a log.
  print: (line) => process.stdout.write(`${line}\n`),
});
process.exit(outcome.kind === 'pr_opened' ? 0 : 1);
