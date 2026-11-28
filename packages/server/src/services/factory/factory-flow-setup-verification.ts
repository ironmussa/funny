/**
 * The setup thread's end and the verification of what it generated
 * (openspec `factory-flow-bootstrap`, Task 4.4): check the generated flow
 * file, start the runner's verification job, poll it and store the proposal
 * or the failure.
 */

import type { FactoryFlowSetupRow } from '@funny/shared/repositories';
import {
  checkOnlyRegressionProofChanged,
  formatParseError,
  isProofReady,
  parseSetupAgentManifest,
  parseWorkflowYaml,
  type ParsedNode,
  type SetupAgentManifest,
} from '@funny/workflows';
import { err, ok, type Result } from 'neverthrow';

import { flowFilePath, sha256Hex } from './factory-flow-setup-helpers.js';
import type { VerifyFlowSetupResult } from './factory-flow-setup-runner.js';
import {
  parseSetupColumn,
  storedFactsSchema,
  storedVerdictsSchema,
} from './factory-flow-setup-schemas.js';
import type {
  SetupServiceContext,
  StoredSetupVerdicts,
  UncoveredScope,
} from './factory-flow-setup-types.js';

function failureReason(result: VerifyFlowSetupResult): string {
  if (result.finding) return `${result.finding}.`;
  if (result.timedOut) return 'Verification timed out before any rule passed.';
  return 'No generated regression proof rule passed verification.';
}

/** Apply a finished verification result to a `verifying` setup row. */
async function applyVerifyResult(
  ctx: SetupServiceContext,
  setup: FactoryFlowSetupRow,
  result: VerifyFlowSetupResult,
  uncovered: UncoveredScope[],
): Promise<void> {
  const { repo } = ctx.deps;
  const verdicts: StoredSetupVerdicts = {
    rules: result.rules,
    uncovered,
    timedOut: result.timedOut,
  };
  if (result.setupOutput !== undefined) verdicts.setupOutput = result.setupOutput;
  const verdictsJson = JSON.stringify(verdicts);

  if (result.acceptedCount > 0 && result.prunedWorkflowYaml) {
    const moved = await repo.transition(
      setup.id,
      'proposed',
      {
        proposedFile: result.prunedWorkflowYaml,
        proposedFileSha: sha256Hex(result.prunedWorkflowYaml),
        verdicts: verdictsJson,
        error: null,
      },
      { fromState: 'verifying' },
    );
    if (moved) ctx.emit(setup.userId, setup.projectId, setup.id, 'proposed');
    return;
  }

  const moved = await repo.transition(
    setup.id,
    'failed',
    { verdicts: verdictsJson, error: failureReason(result) },
    { fromState: 'verifying' },
  );
  if (moved) ctx.emit(setup.userId, setup.projectId, setup.id, 'failed');
}

/**
 * Poll a `verifying` setup's runner job once. Returns `'running'` if still in progress,
 * `'done'` if settled (to `proposed` or `failed`), or `'unreachable'` if runner is offline.
 */
export async function pollVerifyOnceOp(
  ctx: SetupServiceContext,
  setupId: string,
  uncoveredOverride?: UncoveredScope[],
): Promise<'running' | 'done' | 'unreachable'> {
  const { repo, runner } = ctx.deps;
  const setup = await repo.getById(setupId);
  if (!setup || setup.state !== 'verifying') return 'done';

  const fail = async (error: string): Promise<'done'> => {
    await repo.transition(setup.id, 'failed', { error }, { fromState: 'verifying' });
    ctx.emit(setup.userId, setup.projectId, setup.id, 'failed');
    return 'done';
  };

  if (!setup.threadId || !setup.verifyJobId) return fail('Verification job was lost.');

  const polled = await runner.pollVerify(setup.userId, setup.threadId, setup.verifyJobId);
  if (polled.isErr()) {
    if (polled.error.kind === 'not-found') {
      return fail('Verification job was lost (runner restarted).');
    }
    if (polled.error.kind === 'runner-unavailable') return 'unreachable';
    return fail(`Verification failed: ${polled.error.message}`);
  }

  if (polled.value.state === 'running') return 'running';

  const existingVerdicts = parseSetupColumn(storedVerdictsSchema, setup.verdicts, 'verdicts');
  const uncovered = uncoveredOverride ?? existingVerdicts?.uncovered ?? [];
  await applyVerifyResult(ctx, setup, polled.value.result, uncovered);
  return 'done';
}

type ProofRules = NonNullable<ParsedNode['regression_proof']>;

/**
 * The generated flow file may differ from its starting file only in
 * `regression_proof` (Task 3.2), must parse, and must be proof-ready with
 * rules to verify. Returns those rules, or why the file is refused.
 */
function checkGeneratedFlow(
  setup: FactoryFlowSetupRow,
  generatedYaml: string,
): Result<ProofRules, string> {
  const diffCheck = checkOnlyRegressionProofChanged(setup.startingFile, generatedYaml);
  if (!diffCheck.ok) return err(diffCheck.message);

  const parsed = parseWorkflowYaml(generatedYaml, flowFilePath(setup.flowName));
  if (!parsed.ok) return err(`Generated flow file is invalid: ${formatParseError(parsed.error)}`);
  if (!isProofReady(parsed.workflow)) {
    return err('Generated flow file is not proof-ready (no regression_proof rules).');
  }
  const proof = parsed.workflow.nodes.find((n) => n.regression_proof)?.regression_proof;
  if (!proof || proof.rules.length === 0) {
    return err('Generated flow file has no regression_proof rules to verify.');
  }
  return ok(proof);
}

/** The canary manifest the setup agent ends with, in its final message. */
async function readCanaryManifest(
  ctx: SetupServiceContext,
  threadId: string,
): Promise<Result<SetupAgentManifest, string>> {
  const lastMessage = await ctx.deps.getLastAssistantMessage(threadId);
  const manifest = lastMessage ? parseSetupAgentManifest(lastMessage) : null;
  if (!manifest || manifest.canaries.length === 0) {
    return err('Setup agent did not provide a valid JSON canary manifest in its final message.');
  }
  return ok(manifest);
}

/** Start the runner's verification job for the generated rules. */
async function startVerificationJob(
  ctx: SetupServiceContext,
  setup: FactoryFlowSetupRow,
  threadId: string,
  generatedYaml: string,
  proof: ProofRules,
  manifest: SetupAgentManifest,
): Promise<Result<void, string>> {
  const { repo, runner } = ctx.deps;
  // Store the uncovered list first so pollVerifyOnce has it even after a server restart.
  await repo.update(setup.id, {
    verdicts: JSON.stringify({
      rules: [],
      uncovered: manifest.uncovered,
      timedOut: false,
    } satisfies StoredSetupVerdicts),
  });

  const facts = parseSetupColumn(storedFactsSchema, setup.facts, 'facts');
  const started = await runner.startVerify(setup.userId, threadId, {
    baseSha: setup.baseSha,
    workflowYaml: generatedYaml,
    rules: proof.rules,
    setupCommand: proof.setup_command,
    supportGlobs: proof.support_globs,
    canaries: manifest.canaries,
    infraFiles:
      facts && 'infrastructureTests' in facts ? facts.infrastructureTests.map((i) => i.path) : [],
  });
  if (started.isErr()) return err(`Could not start verification job: ${started.error.message}`);

  await repo.update(setup.id, { verifyJobId: started.value.jobId });
  ctx.scheduleVerifyPoll(setup.id, manifest.uncovered);
  return ok(undefined);
}

/** Read, check and start verifying what the setup agent generated. */
async function verifyGenerated(
  ctx: SetupServiceContext,
  setup: FactoryFlowSetupRow,
  threadId: string,
): Promise<Result<void, string>> {
  const flowPath = flowFilePath(setup.flowName);
  const file = await ctx.deps.runner.readSetupFile(setup.userId, threadId, flowPath);
  if (file.isErr()) {
    return err(`Could not read generated flow file ${flowPath}: ${file.error.message}`);
  }
  const generatedYaml = file.value.content;
  const proof = checkGeneratedFlow(setup, generatedYaml);
  if (proof.isErr()) return err(proof.error);
  const manifest = await readCanaryManifest(ctx, threadId);
  if (manifest.isErr()) return err(manifest.error);
  return startVerificationJob(ctx, setup, threadId, generatedYaml, proof.value, manifest.value);
}

/**
 * Handle the setup thread reaching a terminal status (`completed`, `stopped`,
 * `failed`, `interrupted`, or `deleted`).
 */
export async function onSetupThreadTerminalOp(
  ctx: SetupServiceContext,
  threadId: string,
  status: string,
): Promise<void> {
  const { repo } = ctx.deps;
  const setup = await repo.getByThreadId(threadId);
  if (!setup || setup.state !== 'generating') return;

  if (status !== 'completed') {
    const moved = await repo.transition(
      setup.id,
      'failed',
      { error: `Setup thread ended with status "${status}".` },
      { fromState: 'generating' },
    );
    if (moved) ctx.emit(setup.userId, setup.projectId, setup.id, 'failed');
    return;
  }

  // Move generating -> verifying first (compare-and-set prevents duplicate runs).
  const moved = await repo.transition(setup.id, 'verifying', {}, { fromState: 'generating' });
  if (!moved) return;
  ctx.emit(setup.userId, setup.projectId, setup.id, 'verifying');

  const verified = await verifyGenerated(ctx, setup, threadId);
  if (verified.isErr()) {
    await repo.transition(
      setup.id,
      'failed',
      { error: verified.error },
      { fromState: 'verifying' },
    );
    ctx.emit(setup.userId, setup.projectId, setup.id, 'failed');
  }
}
