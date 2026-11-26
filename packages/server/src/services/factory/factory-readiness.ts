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
import type { FactoryReadiness, FactoryRunMetrics } from '@funny/shared/contracts/factory';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { isObject, isString } from '../../lib/value-guards.js';
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

/** A workflow's `branches` / `branches-ignore` list: its strings, or none when it is not a list. */
const branchFilterList = z
  .array(z.unknown())
  .catch([])
  .transform((items) => items.filter((item): item is string => isString(item)));

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

/** The filters of a workflow's `push` or `pull_request` trigger this check reads. */
interface BranchFilters {
  readonly branches?: unknown;
  readonly 'branches-ignore'?: unknown;
  readonly tags?: unknown;
}

/** Whether a trigger's branch filters let an event on `branch` run it. */
function branchFiltersRunOn(branch: string, filters: BranchFilters): boolean {
  const ignored = branchFilterList.parse(
    'branches-ignore' in filters ? filters['branches-ignore'] : undefined,
  );
  if (ignored.some((pattern) => matchesFilter(branch, pattern))) return false;
  const branches = branchFilterList.parse('branches' in filters ? filters.branches : undefined);
  // Only tags: no branch event runs it.
  if (branches.length === 0) return !('tags' in filters) || 'branches-ignore' in filters;
  return passesBranches(branch, branches);
}

type WorkflowTriggerName = 'push' | 'pull_request';

interface WorkflowOnMapping {
  push?: unknown;
  pull_request?: unknown;
}

type WorkflowOn = string | string[] | WorkflowOnMapping;

/** Parse a workflow YAML file and return its `on` trigger block, or undefined on failure. */
function parseWorkflowOn(text: string): WorkflowOn | undefined {
  let workflow: unknown;
  try {
    workflow = parseYaml(text);
  } catch {
    return undefined;
  }
  if (!isObject(workflow)) return undefined;
  // YAML 1.1 readers turn the key `on` into `true`.
  const on =
    ('on' in workflow ? workflow.on : undefined) ??
    ('true' in workflow ? workflow.true : undefined);
  if (isString(on)) return on;
  if (Array.isArray(on)) return on.filter((item): item is string => isString(item));
  if (!isObject(on)) return undefined;
  const mapping: WorkflowOnMapping = {};
  if ('push' in on) mapping.push = on.push;
  if ('pull_request' in on) mapping.pull_request = on.pull_request;
  return mapping;
}

/** Whether a single trigger entry in an `on:` mapping runs on `branch`. */
function triggerMatchesBranch(
  on: WorkflowOnMapping,
  trigger: WorkflowTriggerName,
  branch: string,
): boolean {
  if (!(trigger in on)) return false;
  const filters = on[trigger];
  return !isObject(filters) || branchFiltersRunOn(branch, filters);
}

/** Whether one workflow file runs on `branch` for any of `triggers`. */
function workflowRunsOnBranch(
  text: string,
  branch: string,
  triggers: readonly WorkflowTriggerName[],
): boolean {
  const on = parseWorkflowOn(text);
  if (on === undefined) return false;
  if (isString(on)) return triggers.some((trigger) => trigger === on);
  if (Array.isArray(on)) return triggers.some((trigger) => on.includes(trigger));
  return triggers.some((trigger) => triggerMatchesBranch(on, trigger, branch));
}

/** Whether one workflow file runs on a push to a queue branch. */
export function workflowRunsOnQueueBranches(text: string): boolean {
  return workflowRunsOnBranch(text, QUEUE_BRANCH, ['push']);
}

/** Whether any of the repository's workflows runs on a push to a queue branch. */
export function ciRunsOnQueueBranches(workflows: string[]): boolean {
  return workflows.some(workflowRunsOnQueueBranches);
}

/** Whether one workflow file runs on a pull request into or push to `branch`. */
export function workflowRunsOnLaneBranch(text: string, branch: string): boolean {
  return workflowRunsOnBranch(text, branch, ['pull_request', 'push']);
}

/**
 * Warning stored on a lane when the repository's workflows exclude its branch
 * from both `pull_request` and `push` triggers; null when workflows match it,
 * there are none, or they cannot be read.
 */
export function laneCiWarning(workflows: string[] | null, branch: string): string | null {
  if (!workflows || workflows.length === 0) return null;
  if (workflows.some((text) => workflowRunsOnLaneBranch(text, branch))) return null;
  return `No workflow's pull_request or push branch filter includes "${branch}": pull requests into this lane may get no CI checks.`;
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

/** The median of `values`; null when there are none. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** The merge driver of the newest run that integrated (`runs` newest first); null before one. */
export function lastMergeDriver(
  runs: Array<{ metrics: Pick<FactoryRunMetrics, 'integrateRounds' | 'weaveIntegrations'> }>,
): 'weave' | 'git' | null {
  const last = runs.find((run) => run.metrics.integrateRounds > 0);
  if (!last) return null;
  return last.metrics.weaveIntegrations > 0 ? 'weave' : 'git';
}

/** What readiness is read from. */
export interface ReadinessInputs {
  batchSize: number;
  batchWaitMs: number;
  /** The merge driver of the factory's last integration; null before one. */
  mergeDriver: 'weave' | 'git' | null;
  /** The median CI time of the queue's last batches; null before one. */
  medianCiMs: number | null;
  /** The base branch's rules; null when they cannot be read. */
  rules: BranchRules | null;
  /** The workflow files; null when they cannot be read. */
  workflows: string[] | null;
}

/** What would make the factory merge faster or need the agent less (D12); it never blocks. */
function adviceOf({ mergeDriver, medianCiMs, batchWaitMs, batchSize }: ReadinessInputs): string[] {
  const advice: string[] = [];
  if (mergeDriver === 'git') {
    advice.push(
      "The runner merged the base with git's own driver: install weave (weave-driver on the runner's PATH) so conflicts between separate edits of one file are settled without the agent.",
    );
  }
  if (batchSize > 1 && medianCiMs !== null && batchWaitMs > medianCiMs) {
    advice.push(
      'The queue waits longer for a batch to fill than CI takes to test one: a shorter batch wait merges sooner.',
    );
  }
  return advice;
}

/** How a repository merges through the merge queue, and what to change for batches (D12). */
export function readinessOf(inputs: ReadinessInputs): FactoryReadiness {
  const { batchSize, rules, workflows } = inputs;
  const queueCi = workflows === null ? null : ciRunsOnQueueBranches(workflows);
  const readiness: FactoryReadiness = {
    mode: 'batches',
    queueCi,
    mergeQueueRequired: rules?.mergeQueue ?? null,
    upToDateRequired: rules?.upToDate ?? null,
    mergeDriver: inputs.mergeDriver,
    medianCiMs: inputs.medianCiMs,
    batchWaitMs: inputs.batchWaitMs,
    reasons: [],
    advice: adviceOf(inputs),
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
