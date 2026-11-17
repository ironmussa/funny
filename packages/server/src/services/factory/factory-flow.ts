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
 */

import type { GithubCallError } from '@funny/core/github-app';
import type { PipelineDefinition } from '@funny/pipelines';
import { formatParseError, loadWorkflowCatalog, parseWorkflowYaml } from '@funny/workflows';
import { compileYamlPipeline, type YamlPipelineContext } from '@funny/workflows/compiler';
import { err, ok, type Result } from 'neverthrow';

export type FactoryFlowError =
  /** The flow is missing or invalid: every run of this factory would fail the same way. */
  | { kind: 'invalid'; message: string }
  /** GitHub could not be read now; a later tick may succeed. */
  | { kind: 'unavailable'; message: string };

export interface LoadFactoryFlowDeps {
  /** The default branch's copy of a repository file, or null when absent. */
  readDefaultBranchFile(path: string): PromiseLike<Result<string | null, GithubCallError>>;
  /** The built-in flows' directory (tests). */
  defaultsDir?: string;
}

/** Built-ins written for the orchestrator's workspace, not for a server-run factory. */
const WORKSPACE_ONLY_FLOWS = new Set(['factory-issue']);

export interface FactoryFlow {
  name: string;
  source: 'repository' | 'built-in';
  pipeline: PipelineDefinition<YamlPipelineContext>;
}

function compile(
  yaml: string,
  origin: string,
  source: FactoryFlow['source'],
): Result<FactoryFlow, FactoryFlowError> {
  const parsed = parseWorkflowYaml(yaml, origin);
  if (!parsed.ok) return err({ kind: 'invalid', message: formatParseError(parsed.error) });
  try {
    return ok({
      name: parsed.workflow.name,
      source,
      pipeline: compileYamlPipeline(parsed.workflow),
    });
  } catch (error) {
    return err({
      kind: 'invalid',
      message: `${origin}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** The repository's copy (`.yaml`, then `.yml`), or null when neither exists. */
async function repositoryCopy(
  flowName: string,
  deps: LoadFactoryFlowDeps,
): Promise<Result<{ path: string; yaml: string } | null, FactoryFlowError>> {
  for (const path of [`.funny/workflows/${flowName}.yaml`, `.funny/workflows/${flowName}.yml`]) {
    const read = await deps.readDefaultBranchFile(path);
    if (read.isErr()) return err({ kind: 'unavailable', message: read.error.message });
    if (read.value !== null) return ok({ path, yaml: read.value });
  }
  return ok(null);
}

export async function loadFactoryFlow(
  flowName: string,
  deps: LoadFactoryFlowDeps,
): Promise<Result<FactoryFlow, FactoryFlowError>> {
  const copy = await repositoryCopy(flowName, deps);
  if (copy.isErr()) return err(copy.error);
  if (copy.value) return compile(copy.value.yaml, copy.value.path, 'repository');

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
  return compile(builtIn.yaml, builtIn.filePath, 'built-in');
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
  const builtIns = BUILT_IN_FACTORY_FLOWS.filter((name) => !fromRepo.has(name)).map(
    (name): FactoryFlowChoice => ({ name, source: 'built-in' }),
  );
  const repository = [...fromRepo]
    .sort()
    .map((name): FactoryFlowChoice => ({ name, source: 'repository' }));
  return ok([...builtIns, ...repository]);
}
