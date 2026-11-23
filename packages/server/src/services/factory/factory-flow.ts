/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * The flow a factory run executes (change factory-flow-execution, task 3.3):
 * the repository's `.funny/workflows/<flowName>.yaml` read from its DEFAULT
 * branch, or the built-in flow of that name. Reading only the default branch
 * means a pull request cannot change the flow that would merge it. A
 * repository copy that does not parse is an error, never a silent fallback to
 * the built-in.
 *
 * The factory adds one rule to the engine's (change workflow-dag-engine, D7):
 * every agent step after the first continues the run's one thread, and a
 * thread runs one agent turn at a time, so two agent steps cannot be in
 * parallel branches (`agentStepIssues`).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { GithubCallError } from '@funny/core/github-app';
import type { PipelineDefinition } from '@funny/pipelines';
import type { FactoryFlowDefinition } from '@funny/shared/contracts/factory';
import {
  EMPTY_INTEGRATE_CONFIG,
  formatParseError,
  INTEGRATE_CONFIG_PATH,
  isProofReady,
  parseIntegrateConfig,
  type IntegrateConfig,
  loadWorkflowCatalog,
  parseWorkflowYaml,
  resolvePromptFiles,
  type ParsedWorkflow,
  type PromptFileReader,
  type WorkflowIssue,
} from '@funny/workflows';
import {
  compileYamlPipeline,
  regressionProofOpts,
  type RegressionProofOpts,
  type YamlPipelineContext,
} from '@funny/workflows/compiler';
import { err, ok, type Result } from 'neverthrow';

import {
  formatFactoryFlowProblems,
  validateFactoryFlow,
  type FactoryFlowProblem,
} from './factory-flow-validation.js';
import type { FactoryGithubPort, FactoryRepoReader } from './factory-github.js';
import type { ProjectAgentDefaults, StepOverrides } from './factory-step-options.js';

export type FactoryFlowError =
  /**
   * The flow is missing or invalid: every run of this factory would fail the
   * same way. `problems`: each step and field the factory refused, when that is
   * why.
   */
  | { kind: 'invalid'; message: string; problems?: FactoryFlowProblem[] }
  /** GitHub could not be read now; a later tick may succeed. */
  | { kind: 'unavailable'; message: string };

export interface LoadFactoryFlowDeps {
  /** The default branch's copy of a repository file, or null when absent. */
  readDefaultBranchFile(path: string): PromiseLike<Result<string | null, GithubCallError>>;
  /**
   * The default branch's head commit. With `readFileAt`, the flow and its
   * prompt files are read at that one commit, which the run records.
   */
  defaultBranchHead?(): PromiseLike<Result<{ branch: string; sha: string }, GithubCallError>>;
  /** A repository file as of `ref`, or null when absent there. */
  readFileAt?(path: string, ref: string): PromiseLike<Result<string | null, GithubCallError>>;
  /** The built-in flows' directory (tests). */
  defaultsDir?: string;
}

/** The loader's reads of one repository through the factory's GitHub port, as `reader`. */
export function flowReadsOf(
  port: Pick<FactoryGithubPort, 'readDefaultBranchFile' | 'defaultBranchHead' | 'readFileAt'>,
  reader: FactoryRepoReader,
): LoadFactoryFlowDeps {
  return {
    readDefaultBranchFile: (path) => port.readDefaultBranchFile(reader, path),
    defaultBranchHead: () => port.defaultBranchHead(reader),
    readFileAt: (path, ref) => port.readFileAt(reader, path, ref),
  };
}

/** What a factory adds to the flow it loads: its step overrides and the project's agent defaults. */
export interface FactoryFlowContext {
  overrides?: StepOverrides;
  project?: ProjectAgentDefaults;
}

/** Built-ins written for the orchestrator's workspace, not for a server-run factory. */
const WORKSPACE_ONLY_FLOWS = new Set(['factory-issue']);

export interface FactoryFlow {
  name: string;
  source: 'repository' | 'built-in';
  /** The default-branch commit a repository flow was read at; null for a built-in or when unknown. */
  commit: string | null;
  /** The flow as it runs: parsed, its prompt files resolved (Validate flow summarizes it). */
  workflow: ParsedWorkflow;
  pipeline: PipelineDefinition<YamlPipelineContext>;
  /** Parse warnings of the flow: logged by the caller, they block nothing. */
  warnings: WorkflowIssue[];
  /** Whether its merge may happen: a proof with rules, or the explicit opt-out (`isProofReady`). */
  proofReady: boolean;
  /** Its `regression_proof` step's configuration, when it has one (the watcher re-proves with it). */
  regressionProof?: RegressionProofOpts;
  /**
   * `.funny/integrate.yaml` as of the flow's commit, when the flow has an
   * `integrate` step: the regenerators and checks it runs. Empty without the file.
   */
  integrate: IntegrateConfig;
}

type FlowNode = ParsedWorkflow['nodes'][number];

/**
 * Whether the node works in the run's checkout: an agent on the run's thread
 * (its action or a fixer it may spawn), or a command the runner runs there.
 */
function runsAgent(node: FlowNode): boolean {
  return !!(
    node.spawn_agent ||
    node.retry?.before_retry ||
    node.approval?.on_reject ||
    node.run_command ||
    node.bash ||
    node.integrate
  );
}

/** Every node `id` depends on, directly or not. */
function ancestorsOf(id: string, depsOf: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(depsOf.get(id) ?? [])];
  for (let dep = stack.pop(); dep !== undefined; dep = stack.pop()) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    stack.push(...(depsOf.get(dep) ?? []));
  }
  return seen;
}

/**
 * Two agent steps neither of which depends on the other (directly or not)
 * could run at once and both drive the run's one thread: refused, naming both.
 */
function agentStepIssues(workflow: ParsedWorkflow): WorkflowIssue[] {
  const depsOf = new Map(workflow.nodes.map((n) => [n.id, n.depends_on]));
  const agents = workflow.nodes
    .map((node, index) => ({ node, index, ancestors: ancestorsOf(node.id, depsOf) }))
    .filter(({ node }) => runsAgent(node));
  const issues: WorkflowIssue[] = [];
  for (const [i, a] of agents.entries()) {
    for (const b of agents.slice(i + 1)) {
      if (a.ancestors.has(b.node.id) || b.ancestors.has(a.node.id)) continue;
      issues.push({
        path: `nodes.${b.index}`,
        message: `Agent steps "${a.node.id}" and "${b.node.id}" are in parallel branches, but a factory run has one checkout, used by one agent turn or command at a time. Make one depend on the other.`,
      });
    }
  }
  return issues;
}

/** The prompts of the agents a node may run, with the path of each. */
function agentPrompts(node: FlowNode, index: number): Array<{ path: string; prompt: string }> {
  const prompts = [
    { path: `nodes.${index}.spawn_agent.prompt`, prompt: node.spawn_agent?.prompt },
    { path: `nodes.${index}.retry.before_retry.prompt`, prompt: node.retry?.before_retry?.prompt },
    { path: `nodes.${index}.approval.on_reject.prompt`, prompt: node.approval?.on_reject?.prompt },
  ];
  return prompts.filter((p): p is { path: string; prompt: string } => !!p.prompt);
}

/**
 * Repository copies made before a run got its own worktree branch tell the
 * agent to create "a new branch named {{branch}}". The agent now starts on
 * that branch, so the instruction is wrong (it still works: the agent finds
 * the branch checked out). Warn so the copy gets the built-in's wording.
 */
function staleBranchWordingIssues(workflow: ParsedWorkflow): WorkflowIssue[] {
  return workflow.nodes.flatMap((node, index) =>
    agentPrompts(node, index)
      .filter(({ prompt }) => /\bnew branch\b/i.test(prompt))
      .map(({ path }) => ({
        path,
        message:
          'The prompt asks for a new branch, but a factory run already starts its agent on that branch. Use the wording of the built-in flow: "Work on the branch `{{branch}}`. You may already be on it".',
      })),
  );
}

/**
 * The merge lane (change factory-agent-roles, D8): the concurrency group every
 * `merge` node of a factory flow runs in, one per repository and base branch,
 * shared by every factory on that repository.
 */
const MERGE_LANE_GROUP = 'merge:{{inputs.repo}}:{{inputs.base_branch}}';

/** Whether a rendered concurrency group is a merge lane (its limit is always 1). */
export const isMergeLane = (group: string) => group.startsWith('merge:');

/**
 * The flow with every `merge` node in the merge lane, whatever group or limit
 * it declares (or none): a repository flow cannot merge two pull requests of
 * one repository at once. A batch policy the node declares is kept.
 */
function withMergeLane(workflow: ParsedWorkflow): ParsedWorkflow {
  const nodes = workflow.nodes.map((node) => {
    if (!node.merge) return node;
    const concurrency: NonNullable<FlowNode['concurrency']> = { group: MERGE_LANE_GROUP, limit: 1 };
    if (node.concurrency?.batch) concurrency.batch = node.concurrency.batch;
    return { ...node, concurrency };
  });
  return { ...workflow, nodes };
}

function proofConfigOf(workflow: ParsedWorkflow): RegressionProofOpts | undefined {
  const step = workflow.nodes.find((node) => node.regression_proof)?.regression_proof;
  return step ? regressionProofOpts(step) : undefined;
}

/**
 * The found flow parsed, its prompt files read from where the flow was read,
 * checked against what the factory applies, and compiled.
 */
async function compile(
  found: FoundFlow,
  context: FactoryFlowContext,
): Promise<Result<FactoryFlow, FactoryFlowError>> {
  const { yaml, origin, source } = found;
  const parsed = parseWorkflowYaml(yaml, origin, { validate: agentStepIssues });
  if (!parsed.ok) return err({ kind: 'invalid', message: formatParseError(parsed.error) });
  const prompts = await resolvePromptFiles(parsed.workflow, found.readPromptFile);
  if (!prompts.ok) {
    return err({
      kind: 'invalid',
      message: formatFactoryFlowProblems(origin, prompts.problems),
      problems: prompts.problems,
    });
  }
  const workflow = prompts.workflow;
  const integrate = await integrateConfigOf(workflow, found.readRepositoryFile);
  if (integrate.isErr()) return err(integrate.error);
  const problems = validateFactoryFlow(workflow, context);
  if (problems.length > 0) {
    return err({ kind: 'invalid', message: formatFactoryFlowProblems(origin, problems), problems });
  }
  try {
    return ok({
      name: workflow.name,
      source,
      commit: found.commit,
      workflow,
      pipeline: compileYamlPipeline(withMergeLane(workflow)),
      warnings:
        source === 'repository'
          ? [...parsed.warnings, ...staleBranchWordingIssues(workflow)]
          : parsed.warnings,
      proofReady: isProofReady(workflow),
      regressionProof: proofConfigOf(workflow),
      integrate: integrate.value,
    });
  } catch (error) {
    return err({
      kind: 'invalid',
      message: `${origin}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * The integrate configuration a flow with an `integrate` step runs with, read
 * where the flow was read (the same default-branch commit). A file that does
 * not validate fails the load with every problem, for the run and Validate flow.
 */
async function integrateConfigOf(
  workflow: ParsedWorkflow,
  readRepositoryFile: FoundFlow['readRepositoryFile'],
): Promise<Result<IntegrateConfig, FactoryFlowError>> {
  if (!workflow.nodes.some((node) => node.integrate)) return ok(EMPTY_INTEGRATE_CONFIG);
  const read = await readRepositoryFile(INTEGRATE_CONFIG_PATH);
  if (read.isErr()) return err({ kind: 'unavailable', message: read.error.message });
  if (read.value === null) return ok(EMPTY_INTEGRATE_CONFIG);
  const parsed = parseIntegrateConfig(read.value);
  if (parsed.ok) return ok(parsed.config);
  const problems = parsed.problems.map((problem) => ({ step: INTEGRATE_CONFIG_PATH, ...problem }));
  return err({
    kind: 'invalid',
    message: formatFactoryFlowProblems(INTEGRATE_CONFIG_PATH, problems),
    problems,
  });
}

/** Where a repository flow lives; its prompt files are relative to it. */
const REPO_FLOWS_DIR = '.funny/workflows';

/** How repository files are read for one load: at one commit when the host can, else by branch. */
interface RepositoryReads {
  commit: string | null;
  read(path: string): PromiseLike<Result<string | null, GithubCallError>>;
}

async function repositoryReads(
  deps: LoadFactoryFlowDeps,
): Promise<Result<RepositoryReads, FactoryFlowError>> {
  const { defaultBranchHead, readFileAt } = deps;
  if (!defaultBranchHead || !readFileAt) {
    return ok({ commit: null, read: (path) => deps.readDefaultBranchFile(path) });
  }
  const head = await defaultBranchHead();
  if (head.isErr()) return err({ kind: 'unavailable', message: head.error.message });
  const sha = head.value.sha;
  return ok({ commit: sha, read: (path) => readFileAt(path, sha) });
}

/** A built-in prompt file, from the built-in flows' directory; null when missing. */
function builtInPromptReader(flowFile: string): PromptFileReader {
  return async (path) => readFile(join(dirname(flowFile), path), 'utf8').catch(() => null);
}

/** The repository's copy (`.yaml`, then `.yml`), or null when neither exists. */
async function repositoryCopy(
  flowName: string,
  reads: RepositoryReads,
): Promise<Result<{ path: string; yaml: string } | null, FactoryFlowError>> {
  for (const path of [`${REPO_FLOWS_DIR}/${flowName}.yaml`, `${REPO_FLOWS_DIR}/${flowName}.yml`]) {
    const read = await reads.read(path);
    if (read.isErr()) return err({ kind: 'unavailable', message: read.error.message });
    if (read.value !== null) return ok({ path, yaml: read.value });
  }
  return ok(null);
}

/** Where a flow's YAML was found, before it is compiled. */
interface FoundFlow {
  source: FactoryFlow['source'];
  /** What parse errors name: the repository path, or the built-in's file. */
  origin: string;
  /** The repository path; null for a built-in (its server path is not shown). */
  path: string | null;
  yaml: string;
  /** The default-branch commit it was read at; null for a built-in or when unknown. */
  commit: string | null;
  /** Reads its prompt files, relative to its directory, from where it was read. */
  readPromptFile: PromptFileReader;
  /** Reads a repository file at the commit the flow was read at (a built-in's too). */
  readRepositoryFile: RepositoryReads['read'];
}

async function findFactoryFlow(
  flowName: string,
  deps: LoadFactoryFlowDeps,
): Promise<Result<FoundFlow, FactoryFlowError>> {
  const reads = await repositoryReads(deps);
  if (reads.isErr()) return err(reads.error);
  const copy = await repositoryCopy(flowName, reads.value);
  if (copy.isErr()) return err(copy.error);
  if (copy.value) {
    const { path, yaml } = copy.value;
    const readPromptFile: PromptFileReader = async (relative) => {
      const read = await reads.value.read(`${REPO_FLOWS_DIR}/${relative}`);
      return read.isOk() ? read.value : null;
    };
    return ok({
      source: 'repository',
      origin: path,
      path,
      yaml,
      commit: reads.value.commit,
      readPromptFile,
      readRepositoryFile: reads.value.read,
    });
  }

  if (WORKSPACE_ONLY_FLOWS.has(flowName)) {
    return err({
      kind: 'invalid',
      message: `"${flowName}" runs inside a workspace and never pushes, so it cannot run as a server factory flow. Use "issue-to-pr" (stops at the pull request) or "issue-to-merge".`,
    });
  }
  const { workflows } = await loadWorkflowCatalog({ defaultsDir: deps.defaultsDir });
  const builtIn = workflows.get(flowName);
  if (!builtIn) {
    return err({
      kind: 'invalid',
      message: `No flow named "${flowName}": add .funny/workflows/${flowName}.yaml to the default branch or pick a built-in flow.`,
    });
  }
  return ok({
    source: 'built-in',
    origin: builtIn.filePath,
    path: null,
    yaml: builtIn.yaml,
    commit: null,
    readPromptFile: builtInPromptReader(builtIn.filePath),
    readRepositoryFile: reads.value.read,
  });
}

/**
 * The flow a run of the factory executes, loaded as the run would: from the
 * default branch (at its head commit when the host can say it), its prompt
 * files resolved, refused when it uses an option the factory cannot apply.
 */
export async function loadFactoryFlow(
  flowName: string,
  deps: LoadFactoryFlowDeps,
  context: FactoryFlowContext = {},
): Promise<Result<FactoryFlow, FactoryFlowError>> {
  const found = await findFactoryFlow(flowName, deps);
  if (found.isErr()) return err(found.error);
  return compile(found.value, context);
}

/**
 * The YAML of a flow as `loadFactoryFlow` would find it, for reading: the
 * repository's default-branch copy, else the built-in. Not compiled, so an
 * invalid repository copy can still be read.
 */
export async function readFactoryFlowDefinition(
  flowName: string,
  deps: LoadFactoryFlowDeps,
): Promise<Result<FactoryFlowDefinition, FactoryFlowError>> {
  const found = await findFactoryFlow(flowName, deps);
  return found.map(({ source, path, yaml, origin }) => {
    const definition: FactoryFlowDefinition = { name: flowName, source, path, yaml };
    const same = reviewerSameAsImplementer(yaml, origin);
    if (same !== undefined) definition.reviewerSameAsImplementer = same;
    return definition;
  });
}

/**
 * Whether the flow's `review` step resolves to the provider and model of its
 * implementing agent (its first `spawn_agent`), each falling back to the
 * flow's `defaults`, then to the enabler's own default. Undefined when the
 * flow does not parse or has no review step.
 */
export function reviewerSameAsImplementer(yaml: string, origin: string): boolean | undefined {
  const parsed = parseWorkflowYaml(yaml, origin);
  if (!parsed.ok) return undefined;
  const { nodes, defaults } = parsed.workflow;
  const review = nodes.find((node) => node.review)?.review;
  if (!review) return undefined;
  const implementer = nodes.find((node) => node.spawn_agent)?.spawn_agent;
  const resolved = (step: { provider?: string; model?: string } | undefined) => ({
    provider: step?.provider ?? defaults?.provider ?? null,
    model: step?.model ?? defaults?.model ?? null,
  });
  const a = resolved(implementer);
  const b = resolved(review);
  return a.provider === b.provider && a.model === b.model;
}

/** The built-in flows written for a server-run factory (they push and open a pull request). */
export const BUILT_IN_FACTORY_FLOWS = ['issue-to-merge', 'issue-to-pr'] as const;

/** A flow name as the contract accepts it (`flowName` in `contracts/factory`). */
const FLOW_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface FactoryFlowChoice {
  name: string;
  source: FactoryFlow['source'];
}

/**
 * The flows a send may pick (change factory-manual-queue): the built-in
 * factory flows, plus every `.funny/workflows/*.y{a,}ml` of the default branch
 * (a repository copy replaces the built-in of its name, as `loadFactoryFlow`
 * does), minus the workspace-only ones. A listed repository flow may still fail
 * to compile; the send loads it and says so.
 */
export async function listFactoryFlows(deps: {
  listDefaultBranchDir(path: string): PromiseLike<Result<string[], GithubCallError>>;
}): Promise<Result<FactoryFlowChoice[], FactoryFlowError>> {
  const files = await deps.listDefaultBranchDir('.funny/workflows');
  if (files.isErr()) return err({ kind: 'unavailable', message: files.error.message });
  const fromRepo = new Set(
    files.value
      .map((file) => file.match(/^(.+)\.ya?ml$/)?.[1])
      .filter((name): name is string => !!name && FLOW_NAME.test(name))
      .filter((name) => !WORKSPACE_ONLY_FLOWS.has(name)),
  );
  const builtIns = BUILT_IN_FACTORY_FLOWS.flatMap((name): FactoryFlowChoice[] =>
    fromRepo.has(name) ? [] : [{ name, source: 'built-in' }],
  );
  const repository = [...fromRepo]
    .sort()
    .map((name): FactoryFlowChoice => ({ name, source: 'repository' }));
  return ok([...builtIns, ...repository]);
}
