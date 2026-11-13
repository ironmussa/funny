#!/usr/bin/env bun
/**
 * funny-orchestrator — the long-running issue factory process.
 *
 * Commands: `start` (run the factory) and `status` (list factory runs).
 * Not implemented yet: the issue factory is being rebuilt (see #275).
 */

const USAGE = 'Usage: funny-orchestrator <start|status>';

const command = process.argv[2];

if (command === 'start' || command === 'status') {
  console.error(`funny-orchestrator ${command}: not implemented yet`);
  process.exit(1);
}

console.error(USAGE);
process.exit(command === '--help' || command === '-h' ? 0 : 2);
