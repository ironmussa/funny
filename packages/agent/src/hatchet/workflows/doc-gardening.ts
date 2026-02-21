/**
 * doc-gardening — Hatchet workflow to verify project docs stay up to date.
 *
 * Two sequential tasks:
 *   1. Scan for stale docs (git log comparison between docs/ and src/)
 *   2. Suggest updates using AgentExecutor with a docs-reviewer role
 *
 * Can be triggered on a schedule or manually via API.
 */

import type { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import { execute } from '@funny/core/git';
import { logger } from '../../infrastructure/logger.js';

// ── Input/Output types ──────────────────────────────────────────

interface DocGardeningInput {
  projectPath: string;
  /** How many days since last update before a doc is considered stale (default: 30) */
  staleDays?: number;
  /** Only scan these doc paths (default: ['docs/']) */
  docPaths?: string[];
}

interface StaleDoc {
  path: string;
  lastModified: string;
  daysSinceUpdate: number;
}

interface ScanOutput {
  staleDocs: StaleDoc[];
  totalDocsScanned: number;
}

interface SuggestOutput {
  suggestions: Array<{
    docPath: string;
    reason: string;
    relatedCodeChanges: string[];
  }>;
}

type WorkflowOutput = {
  'scan-stale-docs': ScanOutput;
  'suggest-updates': SuggestOutput;
};

// ── Workflow registration ───────────────────────────────────────

export function registerDocGardeningWorkflow(hatchet: HatchetClient) {
  const workflow = hatchet.workflow<DocGardeningInput, WorkflowOutput>({
    name: 'doc-gardening',
  });

  // Task 1: Scan for stale docs
  workflow.task({
    name: 'scan-stale-docs',
    executionTimeout: '10m',
    fn: async (input) => {
      const { projectPath } = input;
      const staleDays = input.staleDays ?? 30;
      const docPaths = input.docPaths ?? ['docs/'];
      const cutoffMs = staleDays * 24 * 60 * 60 * 1000;
      const now = Date.now();

      const staleDocs: StaleDoc[] = [];
      let totalDocsScanned = 0;

      for (const docPath of docPaths) {
        // Find all markdown files in the docs directory
        const findResult = await execute(
          'git',
          ['ls-files', docPath],
          { cwd: projectPath, reject: false },
        );

        if (findResult.exitCode !== 0 || !findResult.stdout.trim()) continue;

        const files = findResult.stdout.trim().split('\n').filter(Boolean);

        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          totalDocsScanned++;

          // Get the last commit date for this file
          const logResult = await execute(
            'git',
            ['log', '-1', '--format=%aI', '--', file],
            { cwd: projectPath, reject: false },
          );

          if (logResult.exitCode !== 0 || !logResult.stdout.trim()) continue;

          const lastModified = logResult.stdout.trim();
          const lastModifiedDate = new Date(lastModified);
          const daysSinceUpdate = Math.floor((now - lastModifiedDate.getTime()) / (24 * 60 * 60 * 1000));

          if (now - lastModifiedDate.getTime() > cutoffMs) {
            staleDocs.push({ path: file, lastModified, daysSinceUpdate });
          }
        }
      }

      logger.info(
        { totalDocsScanned, staleCount: staleDocs.length, staleDays },
        'Doc staleness scan complete',
      );

      return { staleDocs, totalDocsScanned } as ScanOutput;
    },
  });

  // Task 2: For each stale doc, find related code changes
  workflow.task({
    name: 'suggest-updates',
    parents: ['scan-stale-docs'],
    executionTimeout: '15m',
    fn: async (input, context) => {
      const { projectPath } = input;
      const scanResult = context.parentOutput<ScanOutput>('scan-stale-docs');

      const suggestions: SuggestOutput['suggestions'] = [];

      for (const doc of (await scanResult).staleDocs) {
        // Find code files that changed since the doc was last updated
        const codeChanges = await execute(
          'git',
          ['log', '--name-only', '--pretty=format:', `--since=${doc.lastModified}`, '--', 'src/', 'packages/', 'lib/'],
          { cwd: projectPath, reject: false },
        );

        const changedFiles = codeChanges.stdout
          .split('\n')
          .filter(Boolean)
          .filter((f, i, arr) => arr.indexOf(f) === i) // dedupe
          .slice(0, 20); // limit

        if (changedFiles.length > 0) {
          suggestions.push({
            docPath: doc.path,
            reason: `Not updated in ${doc.daysSinceUpdate} days, but ${changedFiles.length} code files changed since`,
            relatedCodeChanges: changedFiles,
          });
        }
      }

      logger.info(
        { suggestionsCount: suggestions.length },
        'Doc update suggestions generated',
      );

      return { suggestions } as SuggestOutput;
    },
  });

  return workflow;
}
