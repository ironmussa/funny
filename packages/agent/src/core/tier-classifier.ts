/**
 * Classify a changeset into a tier based on git diff stats.
 *
 * Thresholds are configurable via PipelineServiceConfig.
 */

import { execute } from '@funny/core/git';
import type { Tier } from './types.js';

export interface TierThresholds {
  small: { max_files: number; max_lines: number };
  medium: { max_files: number; max_lines: number };
}

interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  totalLines: number;
}

/**
 * Parse the summary line from `git diff --stat`.
 * Example: " 5 files changed, 120 insertions(+), 30 deletions(-)"
 */
function parseDiffStat(output: string): DiffStats {
  const lines = output.trim().split('\n');
  const summary = lines[lines.length - 1] ?? '';

  const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
  const insMatch = summary.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/);

  const filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
  const insertions = insMatch ? parseInt(insMatch[1], 10) : 0;
  const deletions = delMatch ? parseInt(delMatch[1], 10) : 0;

  return {
    filesChanged,
    insertions,
    deletions,
    totalLines: insertions + deletions,
  };
}

export async function classifyTier(
  worktreePath: string,
  baseBranch: string,
  thresholds: TierThresholds,
  override?: Tier,
): Promise<{ tier: Tier; stats: DiffStats }> {
  if (override) {
    return { tier: override, stats: { filesChanged: 0, insertions: 0, deletions: 0, totalLines: 0 } };
  }

  const { stdout } = await execute(
    'git',
    ['diff', '--stat', `${baseBranch}...HEAD`],
    { cwd: worktreePath, reject: false },
  );

  const stats = parseDiffStat(stdout);

  let tier: Tier;
  if (stats.filesChanged <= thresholds.small.max_files && stats.totalLines <= thresholds.small.max_lines) {
    tier = 'small';
  } else if (stats.filesChanged <= thresholds.medium.max_files && stats.totalLines <= thresholds.medium.max_lines) {
    tier = 'medium';
  } else {
    tier = 'large';
  }

  return { tier, stats };
}
