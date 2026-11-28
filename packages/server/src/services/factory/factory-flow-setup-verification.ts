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
} from '@funny/workflows';

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

/**
 * Handle the setup thread reaching a terminal status (`completed`, `stopped`,
 * `failed`, `interrupted`, or `deleted`).
 */
export async function onSetupThreadTerminalOp(
  ctx: SetupServiceContext,
  threadId: string,
  status: string,
): Promise<void> {
  const { repo, runner } = ctx.deps;
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

  const failVerifying = async (errorMsg: string) => {
    await repo.transition(setup.id, 'failed', { error: errorMsg }, { fromState: 'verifying' });
    ctx.emit(setup.userId, setup.projectId, setup.id, 'failed');
  };

  // 1. Read generated flow file from the setup worktree.
  const flowPath = flowFilePath(setup.flowName);
  const fileRes = await runner.readSetupFile(setup.userId, threadId, flowPath);
  if (fileRes.isErr()) {
    await failVerifying(`Could not read generated flow file ${flowPath}: ${fileRes.error.message}`);
    return;
  }
  const generatedYaml = fileRes.value.content;

  // 2. Pure check (Task 3.2): only `regression_proof` may differ from the starting file.
  const diffCheck = checkOnlyRegressionProofChanged(setup.startingFile, generatedYaml);
  if (!diffCheck.ok) {
    await failVerifying(diffCheck.message);
    return;
  }

  // 3. Parse with flow parser and verify `isProofReady`.
  const parsed = parseWorkflowYaml(generatedYaml, flowPath);
  if (!parsed.ok) {
    await failVerifying(`Generated flow file is invalid: ${formatParseError(parsed.error)}`);
    return;
  }
  if (!isProofReady(parsed.workflow)) {
    await failVerifying('Generated flow file is not proof-ready (no regression_proof rules).');
    return;
  }

  const proofNode = parsed.workflow.nodes.find((n) => n.regression_proof);
  const rules = proofNode?.regression_proof?.rules ?? [];
  if (rules.length === 0) {
    await failVerifying('Generated flow file has no regression_proof rules to verify.');
    return;
  }

  // 4. Extract canary manifest & uncovered list from the agent's final message.
  const lastMessage = await ctx.deps.getLastAssistantMessage(threadId);
  const manifest = lastMessage ? parseSetupAgentManifest(lastMessage) : null;
  if (!manifest || manifest.canaries.length === 0) {
    await failVerifying(
      'Setup agent did not provide a valid JSON canary manifest in its final message.',
    );
    return;
  }

  // Store uncovered list early so pollVerifyOnce has it even after a server restart.
  await repo.update(setup.id, {
    verdicts: JSON.stringify({
      rules: [],
      uncovered: manifest.uncovered,
      timedOut: false,
    } satisfies StoredSetupVerdicts),
  });

  const facts = parseSetupColumn(storedFactsSchema, setup.facts, 'facts');
  const infraFiles =
    facts && 'infrastructureTests' in facts ? facts.infrastructureTests.map((i) => i.path) : [];

  // 5. Start verification job on the runner.
  const started = await runner.startVerify(setup.userId, threadId, {
    baseSha: setup.baseSha,
    workflowYaml: generatedYaml,
    rules,
    setupCommand: proofNode?.regression_proof?.setup_command,
    supportGlobs: proofNode?.regression_proof?.support_globs,
    canaries: manifest.canaries,
    infraFiles,
  });
  if (started.isErr()) {
    await failVerifying(`Could not start verification job: ${started.error.message}`);
    return;
  }

  await repo.update(setup.id, { verifyJobId: started.value.jobId });
  ctx.scheduleVerifyPoll(setup.id, manifest.uncovered);
}
