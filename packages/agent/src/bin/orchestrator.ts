#!/usr/bin/env bun
/**
 * funny-orchestrator — the long-running issue factory process (see `cli.ts`).
 * Started on its own (`bun run factory:start`), never by `bun run dev`.
 */

import { runOrchestratorCli } from '../cli.js';
import { ttyPrompt } from '../infrastructure/tty-prompt.js';

const stopped = () =>
  new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });

const code = await runOrchestratorCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  prompt: ttyPrompt,
  untilStopped: stopped,
});
process.exit(code);
