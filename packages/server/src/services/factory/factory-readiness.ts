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

import type { BranchRules } from '@funny/core/github-app';
import type { FactoryReadiness } from '@funny/shared/contracts/factory';
import { parse as parseYaml } from 'yaml';

import type { FactoryGithubPort, FactoryRepoReader } from './factory-github.js';

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

/** Where a repository's GitHub Actions workflows live. */
const WORKFLOWS_DIR = '.github/workflows';

/** The default branch's workflow files, as `reader` reads them; null when they cannot be read. */
export async function readWorkflowFiles(
  port: Pick<FactoryGithubPort, 'listDefaultBranchDir' | 'readDefaultBranchFile'>,
  reader: FactoryRepoReader,
): Promise<string[] | null> {
  const names = await port.listDefaultBranchDir(reader, WORKFLOWS_DIR);
  if (names.isErr()) return null;
  const files: string[] = [];
  for (const name of names.value.filter((n) => /\.ya?ml$/.test(n))) {
    const path = name.includes('/') ? name : `${WORKFLOWS_DIR}/${name}`;
    const text = await port.readDefaultBranchFile(reader, path);
    if (text.isOk() && text.value !== null) files.push(text.value);
  }
  return files;
}

/** What readiness is read from. */
export interface ReadinessInputs {
  batchSize: number;
  /** The base branch's rules; null when they cannot be read. */
  rules: BranchRules | null;
  /** The workflow files; null when they cannot be read. */
  workflows: string[] | null;
}

/** How a repository merges through the merge queue, and what to change for batches (D12). */
export function readinessOf({ batchSize, rules, workflows }: ReadinessInputs): FactoryReadiness {
  const queueCi = workflows === null ? null : ciRunsOnQueueBranches(workflows);
  const readiness: FactoryReadiness = {
    mode: 'batches',
    queueCi,
    mergeQueueRequired: rules?.mergeQueue ?? null,
    upToDateRequired: rules?.upToDate ?? null,
    reasons: [],
  };
  if (rules?.mergeQueue) {
    readiness.mode = 'host-queue';
    readiness.reasons.push(
      "The base branch requires GitHub's merge queue: GitHub tests and merges each pull request.",
    );
    return readiness;
  }
  if (batchSize <= 1) readiness.reasons.push('The batch size is 1: one pull request at a time.');
  if (rules?.upToDate) {
    readiness.reasons.push(
      "The base branch requires pull requests to be up to date before they merge, so a batch cannot land: turn that rule off (the queue tests each batch on the base it lands on) or require GitHub's merge queue.",
    );
  }
  if (queueCi === false) {
    readiness.reasons.push(
      "CI does not run on the merge queue's branches, so a batch would never be tested: run a workflow on pushes to them (on: push: branches: ['factory/queue/**']).",
    );
  }
  if (queueCi === null) {
    readiness.reasons.push("The repository's workflows could not be read.");
  }
  if (readiness.reasons.length > 0) readiness.mode = 'serial';
  return readiness;
}
