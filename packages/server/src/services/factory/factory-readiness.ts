/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * Whether a repository is ready for the merge queue's batches (openspec
 * factory-integration D12). The queue tests a batch on a `factory/queue/<id>`
 * branch, so its CI must run on pushes to those branches; many repositories
 * run CI only on pull requests and on the default branch, and a batch there
 * would never be tested. Read from the default branch's GitHub Actions
 * workflows: a workflow that runs on a push to `factory/queue/x` (no branch
 * filter, or a filter that matches it and no ignore that does).
 */

import { parse as parseYaml } from 'yaml';

/** A branch a queue batch is tested on, to match a workflow's filters with. */
const QUEUE_BRANCH = 'factory/queue/batch';

/** GitHub's branch filter glob: `*` within a segment, `**` across them. */
function matchesFilter(branch: string, pattern: string): boolean {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i += 1;
    } else if (ch === '*') regex += '[^/]*';
    else regex += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${regex}$`).test(branch);
}

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Whether a branch filter list lets `branch` through (`!pattern` excludes, the last match wins). */
function passesBranches(branch: string, patterns: string[]): boolean {
  let passes = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (matchesFilter(branch, pattern.slice(1))) passes = false;
    } else if (matchesFilter(branch, pattern)) passes = true;
  }
  return passes;
}

/** Whether one workflow file runs on a push to a queue branch. */
export function workflowRunsOnQueueBranches(text: string): boolean {
  let workflow: unknown;
  try {
    workflow = parseYaml(text);
  } catch {
    return false;
  }
  if (!workflow || typeof workflow !== 'object') return false;
  // YAML 1.1 readers turn the key `on` into `true`.
  const record = workflow as Record<string, unknown>;
  const on = record.on ?? record.true;
  if (on === 'push') return true;
  if (Array.isArray(on)) return on.includes('push');
  if (!on || typeof on !== 'object') return false;
  if (!('push' in on)) return false;
  const push = (on as Record<string, unknown>).push;
  if (!push || typeof push !== 'object') return true;
  const filters = push as Record<string, unknown>;
  const ignored = asList(filters['branches-ignore']);
  if (ignored.some((pattern) => matchesFilter(QUEUE_BRANCH, pattern))) return false;
  const branches = asList(filters.branches);
  // Only tags: no branch push runs it.
  if (branches.length === 0) return !('tags' in filters) || 'branches-ignore' in filters;
  return passesBranches(QUEUE_BRANCH, branches);
}

/** Whether any of the repository's workflows runs on a push to a queue branch. */
export function ciRunsOnQueueBranches(workflows: string[]): boolean {
  return workflows.some(workflowRunsOnQueueBranches);
}
