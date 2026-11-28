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

export async function startFlowSetupOp(
  ctx: SetupServiceContext,
  actor: FlowSetupActor,
  projectId: string,
  explicitFlowName?: string,
): Promise<Result<FactoryFlowSetupRow, FlowSetupError>> {
  const { deps, emit } = ctx;
  const { repo, runner } = deps;
  if (deps.canSteer) {
    const allowed = await deps.canSteer(actor.userId, projectId);
    if (!allowed) {
      return err({
        kind: 'forbidden',
        status: 403,
        message: 'Requires steer permission on this project',
      });
    }
  }

  const flowName = await ctx.resolveFlowName(actor.userId, projectId, explicitFlowName);

  // Return existing open setup if one is already in progress.
  const existing = await repo.getOpenByUserProjectFlow(actor.userId, projectId, flowName);
  if (existing) return ok(existing);

  const reader = await deps.repoReader(actor.userId, projectId);
  if (!reader) {
    return err({
      kind: 'unavailable',
      status: 503,
      message: 'The repository could not be read.',
    });
  }

  const headResult = await reader.defaultBranchHead();
  if (headResult.isErr()) {
    return err({ kind: 'unavailable', status: 503, message: headResult.error.message });
  }
  const { branch: defaultBranch, sha: baseSha } = headResult.value;

  const loadDeps: LoadFactoryFlowDeps = {
    readDefaultBranchFile: (p) => reader.readDefaultBranchFile(p),
    defaultBranchHead: () => Promise.resolve(ok({ branch: defaultBranch, sha: baseSha })),
    readFileAt: reader.readFileAt ? (p, ref) => reader.readFileAt!(p, ref) : undefined,
    defaultsDir: deps.defaultsDir,
  };

  const loaded = await loadFactoryFlow(flowName, loadDeps);
  if (loaded.isErr()) {
    if (loaded.error.kind === 'unavailable') {
      return err({ kind: 'unavailable', status: 503, message: loaded.error.message });
    }
    return err({ kind: 'invalid-flow', status: 409, message: loaded.error.message });
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
  if (starting.isErr()) return err(starting.error);
  const { startingFile, startingSource, builtinPrompts } = starting.value;

  const setupId = randomUUID();
  const branch = `funny/factory-setup/${setupId.slice(0, 8)}`;

  // Launch the factory-setup worktree thread idle on the member's own runner.
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
      baseBranch: defaultBranch,
      source: 'factory-setup',
    },
  });

  if (started.isErr()) {
    if (started.error.kind === 'runner-unavailable') {
      return err({ kind: 'runner-offline', status: 502, message: started.error.message });
    }
    return err({ kind: 'unavailable', status: 503, message: started.error.message });
  }

  const threadId = started.value.threadId ?? started.value.thread?.id;
  const worktreePath = started.value.thread?.worktreePath
    ? String(started.value.thread.worktreePath)
    : null;
  const runnerId = started.value.runnerId;

  if (!threadId) {
    return err({
      kind: 'unavailable',
      status: 503,
      message: 'Runner did not return a thread ID for setup',
    });
  }

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
    // Concurrent start won the partial unique index; return that open row.
    const raced = await repo.getOpenByUserProjectFlow(actor.userId, projectId, flowName);
    if (raced) return ok(raced);
    return err({
      kind: 'unavailable',
      status: 503,
      message: 'Could not create factory flow setup',
    });
  }

  // Detect test stack facts in the new setup worktree.
  const factsResult = await runner.detectStack(actor.userId, threadId);
  const facts: TestStackFacts | { recognized: false; error: string } = factsResult.isOk()
    ? factsResult.value
    : { recognized: false, error: factsResult.error.message };
  const factsJson = JSON.stringify(facts);
  await repo.update(setupId, { facts: factsJson });
  row = { ...row, facts: factsJson };

  // Render and send the first message to start the setup agent.
  const prompt = await renderFactoryFlowSetupPrompt({
    flowName,
    flowPath: flowFilePath(flowName),
    defaultBranch,
    facts,
    startingFile,
  });
  const sent = await runner.sendFirstMessage(actor.userId, threadId, prompt, branch);
  if (sent.isErr()) {
    await repo.transition(setupId, 'failed', {
      error: `Could not start setup agent: ${sent.error.message}`,
    });
    emit(actor.userId, projectId, setupId, 'failed');
    if (sent.error.kind === 'runner-unavailable') {
      return err({ kind: 'runner-offline', status: 502, message: sent.error.message });
    }
    return err({ kind: 'unavailable', status: 503, message: sent.error.message });
  }

  emit(actor.userId, projectId, setupId, 'generating');
  return ok(row);
}
