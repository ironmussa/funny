/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: core
 * @domain type: pipeline-node
 * @domain layer: application
 *
 * Pre-commit hook auto-fix: when a hook fails, start a fixer agent thread
 * and re-run the hook, up to the configured number of attempts.
 */
import { gitRead, runHookCommand } from '@funny/core/git';
import type { GitWorkflowProgressStep } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { buildPrecommitFixerPrompt } from '../pipeline-prompts.js';
import { createAndStartThread } from '../thread-service/create.js';
import { emitWorkflowEvent } from '../workflow-event-helpers.js';
import { waitForAgentCompletionPoll } from './agent-completion.js';

export class HookFailedError extends Error {
  constructor(
    public hookLabel: string,
    public hookOutput: string,
  ) {
    super(`Hook "${hookLabel}" failed: ${hookOutput}`);
    this.name = 'HookFailedError';
  }
}

interface AutoFixParams {
  cwd: string;
  userId: string;
  threadId?: string;
  projectId?: string;
  workflowId: string;
  hookLabel: string;
  hookCommand: string;
  hookError: string;
  fixModel: string;
  maxIterations: number;
  precommitFixerPrompt?: string;
  setStep: (stepId: string, update: Partial<GitWorkflowProgressStep>) => void;
  hooks: { label: string; command: string }[];
  hookIndex: number;
}

export async function attemptPrecommitAutoFix(params: AutoFixParams): Promise<boolean> {
  const {
    cwd,
    userId,
    threadId,
    projectId,
    workflowId,
    hookLabel,
    hookCommand,
    hookError,
    fixModel,
    maxIterations,
  } = params;

  if (!projectId) {
    log.warn('Pre-commit auto-fix: no projectId, skipping', { namespace: 'pipeline' });
    return false;
  }

  log.info('Pre-commit auto-fix: starting', {
    namespace: 'pipeline',
    hookLabel,
    maxIterations,
  });

  for (let attempt = 1; attempt <= maxIterations; attempt++) {
    const fixingSubItems = params.hooks.map((h, idx) => ({
      label: idx === params.hookIndex ? `${h.label} (auto-fixing, attempt ${attempt})` : h.label,
      status: (idx < params.hookIndex
        ? 'completed'
        : idx === params.hookIndex
          ? 'running'
          : 'pending') as 'pending' | 'running' | 'completed' | 'failed',
    }));
    params.setStep('hooks', { status: 'running', subItems: fixingSubItems });

    let stagedFiles: string[] = [];
    try {
      const result = await gitRead(['diff', '--cached', '--name-only'], {
        cwd,
        reject: false,
      });
      if (result.exitCode === 0) {
        stagedFiles = result.stdout.trim().split('\n').filter(Boolean);
      }
    } catch {
      // Non-critical
    }

    const prompt = buildPrecommitFixerPrompt(
      hookLabel,
      hookError,
      stagedFiles,
      params.precommitFixerPrompt,
    );

    // Create a separate thread for the fixer agent
    let fixerThread: { id: string };
    try {
      const fixerThreadResult = await createAndStartThread({
        projectId,
        userId,
        title: `Pre-commit fix: ${hookLabel} (attempt ${attempt})`,
        mode: 'local',
        provider: 'claude',
        model: fixModel,
        permissionMode: 'autoEdit',
        source: 'automation',
        prompt,
        parentThreadId: threadId,
      });
      if (fixerThreadResult.isErr()) throw fixerThreadResult.error;
      fixerThread = fixerThreadResult.value;

      log.info('Pre-commit auto-fix: fixer thread created', {
        namespace: 'pipeline',
        fixerThreadId: fixerThread.id,
        attempt,
      });

      await waitForAgentCompletionPoll(fixerThread.id);

      // Emit a single workflow:precommit_fix event (consistent with workflow:review / workflow:fix)
      if (threadId) {
        await emitWorkflowEvent(userId, threadId, 'workflow:precommit_fix', {
          workflowId,
          hookLabel,
          attempt,
          fixerThreadId: fixerThread.id,
          status: 'completed',
        });
      }
    } catch (err) {
      log.error('Pre-commit auto-fix: agent failed', {
        namespace: 'pipeline',
        attempt,
        error: String(err),
      });
      return false;
    }

    const retryResultR = await runHookCommand(cwd, hookCommand);
    const retryResult = retryResultR.isOk()
      ? retryResultR.value
      : { success: false, output: retryResultR.error.message };
    if (retryResult.success) {
      log.info('Pre-commit auto-fix: hook now passes', {
        namespace: 'pipeline',
        hookLabel,
        attempt,
      });
      return true;
    }

    log.info('Pre-commit auto-fix: hook still failing', {
      namespace: 'pipeline',
      hookLabel,
      attempt,
      error: retryResult.output,
    });
  }

  log.warn('Pre-commit auto-fix: max iterations reached', {
    namespace: 'pipeline',
    hookLabel,
    maxIterations,
  });
  return false;
}
