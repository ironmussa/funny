/**
 * Which workflow a factory run follows: the repository's own, when its base
 * branch ships one at `.funny/workflows/factory-issue.yaml` (or `.yml`; the
 * `.yaml` wins when both exist), otherwise the built-in `factory-issue`
 * workflow.
 *
 * The override is read from the base branch with git, never from the working
 * tree: the run's branch holds the agent's commits, and a workflow the agent
 * (or a prompt injection) wrote there must not decide what the next step runs.
 * It is found by path, not by the `name` funny's own catalog keys on, so a
 * repository has exactly one place to put it.
 *
 * An override that is present but unusable (unreadable, invalid, named
 * differently, or not compilable) fails the step as an agent failure: the
 * repository asked for its own workflow, so silently running the default
 * would do work it did not ask for, and retrying cannot help.
 */

import { git } from '@funny/core/git';
import type { PipelineDefinition } from '@funny/pipelines';
import { formatParseError, loadWorkflowCatalog, parseWorkflowYaml } from '@funny/workflows';
import type { ParsedWorkflow } from '@funny/workflows';
import { compileYamlPipeline, type YamlPipelineContext } from '@funny/workflows/compiler';

import { resolveBaseRef } from '../adapters/base-ref.js';
import type { FailureKind } from '../domain/step-outcome.js';

export const FACTORY_ISSUE_WORKFLOW = 'factory-issue';

/** Where a repository puts its override, relative to the repository root. */
const OVERRIDE_PATHS = [
  `.funny/workflows/${FACTORY_ISSUE_WORKFLOW}.yaml`,
  `.funny/workflows/${FACTORY_ISSUE_WORKFLOW}.yml`,
];

export type FactoryWorkflow =
  | {
      ok: true;
      source: 'repository' | 'built-in';
      /** The override's path in the repository, when it is the repository's. */
      path?: string;
      pipeline: PipelineDefinition<YamlPipelineContext>;
    }
  | { ok: false; failure: FailureKind; reason: string };

export async function loadFactoryWorkflow(
  repoRoot: string,
  base: string,
): Promise<FactoryWorkflow> {
  const baseRef = await resolveBaseRef(repoRoot, base);
  if (baseRef.isErr()) {
    return { ok: false, failure: 'infra', reason: `base branch ${base}: ${baseRef.error.message}` };
  }
  for (const path of OVERRIDE_PATHS) {
    // `ls-tree` prints the path when the base has it, and nothing when it does not.
    const listed = await git(['ls-tree', '--name-only', baseRef.value, '--', path], repoRoot);
    if (listed.isErr()) return { ok: false, failure: 'infra', reason: listed.error.message };
    if (!listed.value.trim()) continue;

    const yaml = await git(['show', `${baseRef.value}:${path}`], repoRoot);
    if (yaml.isErr()) return invalidOverride(path, `cannot be read: ${yaml.error.message}`);
    return fromOverride(path, yaml.value);
  }
  return builtIn();
}

function fromOverride(path: string, yaml: string): FactoryWorkflow {
  const parsed = parseWorkflowYaml(yaml, path);
  if (!parsed.ok) return invalidOverride(path, formatParseError(parsed.error));
  if (parsed.workflow.name !== FACTORY_ISSUE_WORKFLOW) {
    return invalidOverride(
      path,
      `is named "${parsed.workflow.name}"; it must be named "${FACTORY_ISSUE_WORKFLOW}"`,
    );
  }
  const compiled = compile(parsed.workflow);
  if (!compiled.ok) return invalidOverride(path, compiled.reason);
  return { ok: true, source: 'repository', path, pipeline: compiled.pipeline };
}

async function builtIn(): Promise<FactoryWorkflow> {
  const { workflows, warnings } = await loadWorkflowCatalog();
  const entry = workflows.get(FACTORY_ISSUE_WORKFLOW);
  if (!entry) {
    const details = warnings.length > 0 ? `: ${warnings.join('; ')}` : '';
    return {
      ok: false,
      failure: 'infra',
      reason: `built-in workflow "${FACTORY_ISSUE_WORKFLOW}" not found${details}`,
    };
  }
  const compiled = compile(entry.workflow);
  if (!compiled.ok) return { ok: false, failure: 'infra', reason: compiled.reason };
  return { ok: true, source: 'built-in', pipeline: compiled.pipeline };
}

function compile(
  workflow: ParsedWorkflow,
): { ok: true; pipeline: PipelineDefinition<YamlPipelineContext> } | { ok: false; reason: string } {
  try {
    return { ok: true, pipeline: compileYamlPipeline(workflow) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function invalidOverride(path: string, problem: string): FactoryWorkflow {
  return {
    ok: false,
    failure: 'agent',
    reason: `The repository's workflow override ${path} ${problem}`,
  };
}
