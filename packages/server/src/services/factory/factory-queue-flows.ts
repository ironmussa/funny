/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * The read-only side of a factory's queue (change factory-manual-queue): the
 * flows a send may pick, one flow's definition, validating a flow, the flows
 * that run without an issue, and how the repository merges through the merge
 * queue. Split out of `factory-queue.ts`; nothing here writes.
 */

import type { GithubCallError } from '@funny/core/github-app';
import type {
  FactoryFlowDefinition,
  FactoryFlowOption,
  FactoryFlowValidation,
  FactoryIssuelessFlow,
  FactoryReadiness,
} from '@funny/shared/contracts/factory';
import { validateSecretName } from '@funny/shared/project-secrets';
import { err, ok, okAsync, type Result } from 'neverthrow';

import type { FactoryBatchesRepository } from './factory-batches.js';
import {
  FACTORY_FLOW_INPUTS,
  formatFactoryFlowProblems,
  summarizeFactoryFlow,
  validateFlowForIssuelessRun,
} from './factory-flow-validation.js';
import {
  BUILT_IN_FACTORY_FLOWS,
  listFactoryFlows,
  flowReadsOf,
  loadFactoryFlow,
  readFactoryFlowDefinition,
} from './factory-flow.js';
import type { FactoryGithubPort, FactoryRepoReader } from './factory-github.js';
import type { FactoryQueueError } from './factory-queue.js';
import { lastMergeDriver, medianOf, readinessOf, readWorkflowFiles } from './factory-readiness.js';
import type { createFactoryRunsRepository } from './factory-runs.js';
import { projectAgentDefaults, type WatchedFactory } from './factory-settings.js';
import type { FactoryTarget } from './factory-watcher.js';

export const NOT_RUNNING_HERE = 'The issue factory is not running on this server.';

/** A flow a send cannot use: unknown or invalid (400), or the repository unreadable now. */
export function flowRefusal(error: {
  kind: 'invalid' | 'unavailable';
  message: string;
}): FactoryQueueError {
  return error.kind === 'invalid'
    ? { kind: 'invalid-flow', message: error.message }
    : { kind: 'cannot-work', message: `The repository could not be read: ${error.message}` };
}

/** What the queue's flow reads need, its dependencies already resolved. */
export interface FactoryQueueFlowsContext {
  runs: Pick<ReturnType<typeof createFactoryRunsRepository>, 'list'>;
  batches: Pick<FactoryBatchesRepository, 'ciDurations'>;
  github: () => FactoryGithubPort | null;
  target: (factory: WatchedFactory) => Promise<FactoryTarget | null>;
  loadFactory: (factoryId: string) => Promise<WatchedFactory | null>;
}

/** The queue's flow reads over one set of dependencies. */
export function createFactoryQueueFlows(ctx: FactoryQueueFlowsContext) {
  const { runs, batches, github, target, loadFactory } = ctx;

  /** The factory's repository reader when it resolves now, else null (paused does not matter here). */
  async function readerOf(
    factoryId: string,
  ): Promise<{ port: FactoryGithubPort; reader: FactoryRepoReader } | null> {
    const factory = await loadFactory(factoryId);
    const port = github();
    if (!factory || !port) return null;
    const where = await target(factory);
    if (!where || 'reason' in where) return null;
    return {
      port,
      reader: { repo: where.repo, ownerId: factory.userId, projectId: factory.projectId },
    };
  }

  async function flows(factoryId: string): Promise<FactoryFlowOption[]> {
    const builtIns = BUILT_IN_FACTORY_FLOWS.map((name): FactoryFlowOption => ({
      name,
      source: 'built-in',
    }));
    const where = await readerOf(factoryId);
    if (!where) return builtIns;
    const listed = await listFactoryFlows({
      listDefaultBranchDir: (path) => where.port.listDefaultBranchDir(where.reader, path),
    });
    return listed.isOk() ? listed.value : builtIns;
  }

  /**
   * One flow's YAML. Without a factory, or when its repository cannot be read
   * now, only the built-ins are found, as in `flows` (which lists the
   * built-ins in that case).
   */
  async function flowDefinition(
    factoryId: string | null,
    flowName: string,
  ): Promise<Result<FactoryFlowDefinition, FactoryQueueError>> {
    const builtInOnly = {
      readDefaultBranchFile: () => okAsync<string | null, GithubCallError>(null),
    };
    const where = factoryId ? await readerOf(factoryId) : null;
    if (!where) return (await readFactoryFlowDefinition(flowName, builtInOnly)).mapErr(flowRefusal);
    const read = await readFactoryFlowDefinition(flowName, {
      readDefaultBranchFile: (path) => where.port.readDefaultBranchFile(where.reader, path),
    });
    if (read.isErr() && read.error.kind === 'unavailable') {
      return (await readFactoryFlowDefinition(flowName, builtInOnly)).mapErr(flowRefusal);
    }
    return read.mapErr(flowRefusal);
  }

  /** How the factory's repository merges through the merge queue, and why (D12). */
  async function readiness(factoryId: string | null): Promise<FactoryReadiness> {
    const factory = factoryId ? await loadFactory(factoryId) : null;
    const where = factoryId ? await readerOf(factoryId) : null;
    if (!factory || !where) {
      return {
        mode: 'serial',
        queueCi: null,
        mergeQueueRequired: null,
        upToDateRequired: null,
        mergeDriver: null,
        medianCiMs: null,
        batchWaitMs: (factory?.batch.waitSeconds ?? 0) * 1000,
        reasons: [NOT_RUNNING_HERE],
        advice: [],
      };
    }
    const base = await where.port.defaultBranch(where.reader);
    const host = where.port.pullRequests.integrationFor?.({
      userId: factory.userId,
      projectId: factory.projectId,
    });
    const rules =
      base.isOk() && host ? await host.branchRules(where.reader.repo, base.value) : null;
    const ran = await runs.list(factory.id);
    const durations = await batches.ciDurations(where.reader.repo);
    return readinessOf({
      batchSize: factory.batch.size,
      batchWaitMs: factory.batch.waitSeconds * 1000,
      mergeDriver: ran.isOk() ? lastMergeDriver(ran.value) : null,
      medianCiMs: durations.isOk() ? medianOf(durations.value) : null,
      rules: rules?.isOk() ? rules.value : null,
      workflows: await readWorkflowFiles(where.port, where.reader),
    });
  }

  /**
   * Validate flow (openspec factory-flow-step-options, D8): the flow loaded
   * exactly as an admitted run of this factory would load it now (default
   * branch at its head, prompt files, the factory checks, its step overrides
   * and the project's defaults), and its summary or every problem. Reads only:
   * no run, no thread. Without a factory, the built-ins only.
   */
  async function validateFlow(
    factoryId: string | null,
    projectId: string,
    flowName: string,
  ): Promise<Result<FactoryFlowValidation, FactoryQueueError>> {
    const factory = factoryId ? await loadFactory(factoryId) : null;
    const context = {
      overrides: factory?.stepOverrides ?? {},
      project: await projectAgentDefaults(projectId),
      dependencies: factory?.dependencies,
    };
    const where = factoryId ? await readerOf(factoryId) : null;
    const reads = where
      ? flowReadsOf(where.port, where.reader)
      : { readDefaultBranchFile: () => okAsync<string | null, GithubCallError>(null) };
    const flow = await loadFactoryFlow(flowName, reads, context);
    if (flow.isErr()) {
      if (flow.error.kind === 'unavailable') return err(flowRefusal(flow.error));
      const problems = flow.error.problems ?? [
        { step: 'flow', field: 'flow', message: flow.error.message },
      ];
      return ok({ ok: false, message: flow.error.message, problems });
    }
    const summary = summarizeFactoryFlow(flow.value.workflow, context);
    return ok({
      ok: true,
      name: flow.value.name,
      source: flow.value.source,
      commit: flow.value.commit,
      ...summary,
      // What loading the flow found too (stale wording of a repository copy).
      warnings: [...summary.warnings, ...flow.value.warnings.map((warning) => warning.message)],
    });
  }

  const builtInReads = {
    readDefaultBranchFile: () => okAsync<string | null, GithubCallError>(null),
  };

  /** The flow as a run of this factory would load it now; the built-ins when its repository cannot be read. */
  async function loadForFactory(factoryId: string | null, flowName: string) {
    const where = factoryId ? await readerOf(factoryId) : null;
    return loadFactoryFlow(flowName, where ? flowReadsOf(where.port, where.reader) : builtInReads);
  }

  /**
   * Whether a flow can run without an issue, and the inputs a member types to
   * start it (change flow-triggers). Reads only.
   */
  async function issuelessFlow(
    factoryId: string | null,
    flowName: string,
  ): Promise<Result<FactoryIssuelessFlow, FactoryQueueError>> {
    const flow = await loadForFactory(factoryId, flowName);
    if (flow.isErr()) {
      if (flow.error.kind === 'unavailable') return err(flowRefusal(flow.error));
      return ok({
        inputs: [],
        problems: flow.error.problems ?? [
          { step: 'flow', field: 'flow', message: flow.error.message },
        ],
      });
    }
    const declared = Object.entries(flow.value.workflow.inputs ?? {}).filter(
      ([name]) => !FACTORY_FLOW_INPUTS.has(name),
    );
    return ok({
      inputs: declared.map(([name, def]) => ({
        name,
        required: def.required === true && def.default === undefined,
        description: def.description ?? null,
      })),
      // Every declared input counts as typed here: only the steps are judged.
      problems: validateFlowForIssuelessRun(
        flow.value.workflow,
        declared.map(([name]) => name),
      ),
    });
  }

  /** Why these input values cannot start `flowName` without an issue, or null. */
  async function issuelessRefusal(
    factoryId: string,
    flowName: string,
    inputs: Record<string, string>,
  ): Promise<FactoryQueueError | null> {
    const reserved = Object.keys(inputs).find(
      (name) =>
        FACTORY_FLOW_INPUTS.has(name) || validateSecretName(name.toUpperCase()) === 'reserved',
    );
    if (reserved) {
      return {
        kind: 'invalid',
        message: `The input "${reserved}" cannot be set: the factory supplies it, or its name is reserved for a credential.`,
      };
    }
    const flow = await loadForFactory(factoryId, flowName);
    if (flow.isErr()) return flowRefusal(flow.error);
    const supplied = Object.entries(inputs).flatMap(([name, value]) =>
      value.trim() === '' ? [] : [name],
    );
    const problems = validateFlowForIssuelessRun(flow.value.workflow, supplied);
    if (problems.length === 0) return null;
    return {
      kind: 'invalid-flow',
      message: formatFactoryFlowProblems(`The flow "${flowName}"`, problems),
    };
  }

  return {
    readerOf,
    flows,
    flowDefinition,
    readiness,
    validateFlow,
    issuelessFlow,
    issuelessRefusal,
  };
}
