/**
 * Starting a guided factory flow setup on the member's own runner
 * (openspec `factory-flow-bootstrap`, Task 4.2).
 */

import { randomUUID } from 'node:crypto';

import type { TestStackFacts } from '@funny/core';
import type { FactoryFlowSetupRow } from '@funny/shared/repositories';
import { loadWorkflowCatalog, renderFactoryFlowSetupPrompt } from '@funny/workflows';
import { err, ok, type Result } from 'neverthrow';

import { collectBuiltInPrompts, flowFilePath } from './factory-flow-setup-helpers.js';
import type {
  FlowSetupActor,
  FlowSetupError,
  FlowSetupRepoReader,
  SetupServiceContext,
  StoredSetupPromptFile,
} from './factory-flow-setup-types.js';
import { type FactoryFlow, loadFactoryFlow, type LoadFactoryFlowDeps } from './factory-flow.js';

interface StartingFlowFile {
  startingFile: string;
  startingSource: 'repo' | 'builtin';
  builtinPrompts: StoredSetupPromptFile[];
}

/** Read the exact starting YAML: the repository's copy if present, else the built-in one. */
async function readStartingFlowFile(
  reader: FlowSetupRepoReader,
  flowName: string,
  source: FactoryFlow['source'],
  defaultsDir: string | undefined,
): Promise<Result<StartingFlowFile, FlowSetupError>> {
  if (source === 'repository') {
    const repoFile = await reader.readDefaultBranchFile(flowFilePath(flowName));
    if (repoFile.isErr() || !repoFile.value) {
      return err({
        kind: 'unavailable',
        status: 503,
        message: repoFile.isErr()
          ? repoFile.error.message
          : 'Flow file disappeared from default branch',
      });
    }
    return ok({ startingFile: repoFile.value, startingSource: 'repo', builtinPrompts: [] });
  }

  const { workflows } = await loadWorkflowCatalog({ defaultsDir });
  const entry = workflows.get(flowName);
  if (!entry) {
    return err({
      kind: 'invalid-flow',
      status: 409,
      message: `Built-in flow "${flowName}" not found`,
    });
  }
  return ok({
    startingFile: entry.yaml,
    startingSource: 'builtin',
    builtinPrompts: await collectBuiltInPrompts(flowName, entry.yaml, defaultsDir),
  });
}

type SetupResult<T> = Result<T, FlowSetupError>;

const unavailable = (message: string): FlowSetupError => ({
  kind: 'unavailable',
  status: 503,
  message,
});

/** A runner failure as the error the member sees: offline (502) or otherwise unavailable. */
function runnerFailure(error: { kind: string; message: string }): FlowSetupError {
  return error.kind === 'runner-unavailable'
    ? { kind: 'runner-offline', status: 502, message: error.message }
    : unavailable(error.message);
}

interface FlowToConfigure extends StartingFlowFile {
  defaultBranch: string;
  baseSha: string;
}

/** The default branch's head and the flow file to start from, refused when already proof-ready. */
async function loadFlowToConfigure(
  ctx: SetupServiceContext,
  actor: FlowSetupActor,
  projectId: string,
  flowName: string,
): Promise<SetupResult<FlowToConfigure>> {
  const { deps } = ctx;
  const reader = await deps.repoReader(actor.userId, projectId);
  if (!reader) return err(unavailable('The repository could not be read.'));

  const head = await reader.defaultBranchHead();
  if (head.isErr()) return err(unavailable(head.error.message));
  const { branch: defaultBranch, sha: baseSha } = head.value;

  const loadDeps: LoadFactoryFlowDeps = {
    readDefaultBranchFile: (p) => reader.readDefaultBranchFile(p),
    defaultBranchHead: () => Promise.resolve(ok({ branch: defaultBranch, sha: baseSha })),
    readFileAt: reader.readFileAt ? (p, ref) => reader.readFileAt!(p, ref) : undefined,
    defaultsDir: deps.defaultsDir,
  };
  const loaded = await loadFactoryFlow(flowName, loadDeps);
  if (loaded.isErr()) {
    return err(
      loaded.error.kind === 'unavailable'
        ? unavailable(loaded.error.message)
        : { kind: 'invalid-flow', status: 409, message: loaded.error.message },
    );
  }
  if (loaded.value.proofReady) {
    return err({
      kind: 'already-ready',
      status: 409,
      message: `Flow "${flowName}" is already proof-ready.`,
    });
  }

  const starting = await readStartingFlowFile(
    reader,
    flowName,
    loaded.value.source,
    deps.defaultsDir,
  );
  return starting.map((file) => ({ ...file, defaultBranch, baseSha }));
}

interface LaunchedThread {
  threadId: string;
  worktreePath: string | null;
  runnerId: string;
}

/** Launch the factory-setup worktree thread idle on the member's own runner. */
async function launchSetupWorktree(
  ctx: SetupServiceContext,
  actor: FlowSetupActor,
  projectId: string,
  flowName: string,
  branch: string,
  baseBranch: string,
): Promise<SetupResult<LaunchedThread>> {
  const started = await ctx.launchSetupThread({
    userId: actor.userId,
    orgId: actor.orgId,
    role: actor.role,
    orgName: actor.orgName,
    intent: 'idle',
    body: {
      projectId,
      title: `[Factory Setup] Configure ${flowName}`,
      mode: 'worktree',
      branch,
      baseBranch,
      source: 'factory-setup',
    },
  });
  if (started.isErr()) return err(runnerFailure(started.error));

  const threadId = started.value.threadId ?? started.value.thread?.id;
  if (!threadId) return err(unavailable('Runner did not return a thread ID for setup'));
  const worktreePath = started.value.thread?.worktreePath;
  return ok({
    threadId,
    worktreePath: worktreePath ? String(worktreePath) : null,
    runnerId: started.value.runnerId,
  });
}

/** Detect the stack, then send the setup agent its first message. */
async function startSetupAgent(
  ctx: SetupServiceContext,
  row: FactoryFlowSetupRow,
  threadId: string,
): Promise<SetupResult<FactoryFlowSetupRow>> {
  const { repo, runner } = ctx.deps;
  const factsResult = await runner.detectStack(row.userId, threadId);
  const facts: TestStackFacts | { recognized: false; error: string } = factsResult.isOk()
    ? factsResult.value
    : { recognized: false, error: factsResult.error.message };
  const factsJson = JSON.stringify(facts);
  await repo.update(row.id, { facts: factsJson });

  const prompt = await renderFactoryFlowSetupPrompt({
    flowName: row.flowName,
    flowPath: flowFilePath(row.flowName),
    defaultBranch: row.defaultBranch,
    facts,
    startingFile: row.startingFile,
  });
  const sent = await runner.sendFirstMessage(row.userId, threadId, prompt, row.branch);
  if (sent.isErr()) {
    await repo.transition(row.id, 'failed', {
      error: `Could not start setup agent: ${sent.error.message}`,
    });
    ctx.emit(row.userId, row.projectId, row.id, 'failed');
    return err(runnerFailure(sent.error));
  }

  ctx.emit(row.userId, row.projectId, row.id, 'generating');
  return ok({ ...row, facts: factsJson });
}

export async function startFlowSetupOp(
  ctx: SetupServiceContext,
  actor: FlowSetupActor,
  projectId: string,
  explicitFlowName?: string,
): Promise<SetupResult<FactoryFlowSetupRow>> {
  const { repo, canSteer } = ctx.deps;
  if (canSteer && !(await canSteer(actor.userId, projectId))) {
    return err({
      kind: 'forbidden',
      status: 403,
      message: 'Requires steer permission on this project',
    });
  }

  const flowName = await ctx.resolveFlowName(actor.userId, projectId, explicitFlowName);
  // Return the open setup when one is already in progress.
  const existing = await repo.getOpenByUserProjectFlow(actor.userId, projectId, flowName);
  if (existing) return ok(existing);

  const flow = await loadFlowToConfigure(ctx, actor, projectId, flowName);
  if (flow.isErr()) return err(flow.error);
  const { defaultBranch, baseSha, startingFile, startingSource, builtinPrompts } = flow.value;

  const setupId = randomUUID();
  const branch = `funny/factory-setup/${setupId.slice(0, 8)}`;
  const launched = await launchSetupWorktree(
    ctx,
    actor,
    projectId,
    flowName,
    branch,
    defaultBranch,
  );
  if (launched.isErr()) return err(launched.error);
  const { threadId, worktreePath, runnerId } = launched.value;

  const now = new Date().toISOString();
  let row: FactoryFlowSetupRow;
  try {
    row = await repo.insert({
      id: setupId,
      projectId,
      userId: actor.userId,
      flowName,
      defaultBranch,
      baseSha,
      threadId,
      branch,
      worktreePath,
      runnerId,
      state: 'generating',
      startingFile,
      startingSource,
      builtinPrompts: builtinPrompts.length > 0 ? JSON.stringify(builtinPrompts) : null,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // A concurrent start won the partial unique index: answer with its open row.
    const raced = await repo.getOpenByUserProjectFlow(actor.userId, projectId, flowName);
    return raced ? ok(raced) : err(unavailable('Could not create factory flow setup'));
  }

  return startSetupAgent(ctx, row, threadId);
}
