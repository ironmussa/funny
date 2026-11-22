/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: core
 * @domain type: pipeline-node
 * @domain layer: application
 *
 * The test-fix sub-pipeline: run the project's test command; when it fails
 * and auto-fix is on, a fixer agent fixes the failures and its changes are
 * committed on the parent thread. Loops until the tests pass.
 */
import { gitRead, runHookCommand } from '@funny/core/git';
import { definePipeline, node } from '@funny/pipelines';

import { log } from '../../lib/logger.js';
import { buildTestFixerPrompt } from '../pipeline-prompts.js';
import * as tm from '../thread-manager.js';
import { createAndStartThread } from '../thread-service/create.js';
import { emitWorkflowEvent } from '../workflow-event-helpers.js';
import { waitForAgentCompletionPoll } from './agent-completion.js';
import type { GitPipelineContext } from './context.js';
import { commitPipelineFix } from './node-helpers.js';

async function testRunnerNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  if (!ctx.testCommand) throw new Error('Test command is required');

  ctx.setStep('test-run', { status: 'running' });

  const resultR = await runHookCommand(ctx.cwd, ctx.testCommand);
  const result = resultR.isOk() ? resultR.value : { success: false, output: resultR.error.message };

  if (result.success) {
    log.info('Pipeline: tests passed', { namespace: 'pipeline', iteration: ctx.testIteration });
    ctx.setStep('test-run', { status: 'completed' });

    if (ctx.threadId) {
      await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:test_run', {
        workflowId: ctx.workflowId,
        iteration: ctx.testIteration,
        passed: true,
      });
    }

    return { ...ctx, testPassed: true, testOutput: null };
  }

  log.info('Pipeline: tests failed', {
    namespace: 'pipeline',
    iteration: ctx.testIteration,
    output: (result.output || '').slice(0, 500),
  });

  ctx.setStep('test-run', { status: 'failed', error: 'Tests failed' });

  if (ctx.threadId) {
    await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:test_run', {
      workflowId: ctx.workflowId,
      iteration: ctx.testIteration,
      passed: false,
    });
  }

  return { ...ctx, testPassed: false, testOutput: result.output || 'Tests failed' };
}

/**
 * Stage the test fixer's changes on the parent thread and commit them as a
 * pipeline commit. Returns whether there was anything to commit.
 */
async function commitTestFix(ctx: GitPipelineContext, threadId: string): Promise<boolean> {
  const parentThread = await tm.getThread(threadId);
  const targetCwd = parentThread?.worktreePath || parentThread?.initCwd || ctx.cwd;

  await gitRead(['add', '-A'], { cwd: targetCwd, reject: false });

  // Check if there are staged changes to commit
  const statusResult = await gitRead(['status', '--porcelain'], {
    cwd: targetCwd,
    reject: false,
  });
  const hasChanges = statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;

  if (hasChanges) {
    const commitMessage = `fix: address test failures (iteration ${ctx.testIteration})`;
    await commitPipelineFix({ ...ctx, threadId }, targetCwd, commitMessage);
  }
  return hasChanges;
}

async function testFixerNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  if (!ctx.threadId || !ctx.projectId) {
    throw new Error('Test fixer requires threadId and projectId');
  }
  if (!ctx.testCommand || !ctx.testOutput) {
    throw new Error('Test fixer requires testCommand and testOutput');
  }

  ctx.setStep('test-fixer', { status: 'running' });

  const prompt = buildTestFixerPrompt(
    ctx.testCommand,
    ctx.testOutput,
    ctx.testIteration,
    ctx.testFixerPrompt,
  );

  const fixerThreadResult = await createAndStartThread({
    projectId: ctx.projectId,
    userId: ctx.userId,
    title: `Test fix (iteration ${ctx.testIteration})`,
    mode: 'local',
    provider: 'claude',
    model: ctx.testFixModel,
    permissionMode: 'autoEdit',
    source: 'automation',
    prompt,
    parentThreadId: ctx.threadId,
  });
  if (fixerThreadResult.isErr()) throw fixerThreadResult.error;
  const fixerThread = fixerThreadResult.value;

  log.info('Pipeline: test fixer thread created', {
    namespace: 'pipeline',
    fixerThreadId: fixerThread.id,
    iteration: ctx.testIteration,
  });

  await waitForAgentCompletionPoll(fixerThread.id);

  const hasChanges = await commitTestFix(ctx, ctx.threadId);

  ctx.setStep('test-fixer', { status: 'completed' });

  await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:test_fix', {
    workflowId: ctx.workflowId,
    iteration: ctx.testIteration,
    fixerThreadId: fixerThread.id,
    hasChanges,
  });

  return {
    ...ctx,
    testFixerThreadId: fixerThread.id,
    testOutput: null,
    testPassed: false,
    testIteration: ctx.testIteration + 1,
  };
}

/** The test-fix sub-pipeline — runs tests then fixes failures in a loop. */
export const testFixSubPipeline = definePipeline<GitPipelineContext>({
  name: 'test-fix',
  nodes: [
    node('test-run', testRunnerNode),
    node('test-fixer', testFixerNode, {
      when: (ctx) => !ctx.testPassed && ctx.testFixEnabled,
    }),
  ],
  loop: {
    from: 'test-run',
    until: (ctx) => ctx.testPassed || !ctx.testFixEnabled,
  },
});
