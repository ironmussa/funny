#!/usr/bin/env bun
/**
 * Enforce aggregate line coverage for packages/server (see the shared
 * scripts/coverage-gate.ts; `SERVER_COVERAGE_MIN_LINES` overrides the minimum).
 *
 * Files excluded from coverage (see bunfig.toml):
 *   - src/routes/pipelines.ts (approval gates proxied to the runner)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCoverageGate } from '../../../scripts/coverage-gate';

const MIN_LINE_COVERAGE = Number(process.env.SERVER_COVERAGE_MIN_LINES ?? 65);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.exit(runCoverageGate(pkgRoot, MIN_LINE_COVERAGE, ['--isolate', '--timeout', '20000']));
