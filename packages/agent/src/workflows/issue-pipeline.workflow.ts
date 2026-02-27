/**
 * IssuePipelineWorkflow — orchestrates the full issue-to-PR pipeline.
 *
 * Steps: plan → create worktree → implement → commit → push → create PR
 *
 * Extracted from routes/sessions.ts to separate workflow logic from HTTP handling.
 */

import { nanoid } from 'nanoid';

import type { OrchestratorAgent } from '../agents/developer/orchestrator-agent.js';
import type { PipelineServiceConfig } from '../config/schema.js';
import type { SessionStore } from '../core/session-store.js';
import type { Session, ImplementationPlan } from '../core/session.js';
import { logger } from '../infrastructure/logger.js';
import type { IssueDetail } from '../trackers/tracker.js';
import type { IWorkflow, WorkflowDeps } from './types.js';
import { WorkflowEventEmitter } from './workflow-event-emitter.js';

// ── Types ──────────────────────────────────────────────────────

export interface IssuePipelineDeps extends WorkflowDeps {
  sessionStore: SessionStore;
  orchestratorAgent: OrchestratorAgent;
  config: PipelineServiceConfig;
}

export interface PipelineInput {
  session: Session;
  issue: IssueDetail;
  projectPath: string;
  baseBranch: string;
}

// ── Workflow ───────────────────────────────────────────────────

export class IssuePipelineWorkflow implements IWorkflow {
  readonly name = 'issue-pipeline';

  private emitter: WorkflowEventEmitter;
  private sessionStore: SessionStore;
  private orchestratorAgent: OrchestratorAgent;
  private config: PipelineServiceConfig;

  constructor(deps: IssuePipelineDeps) {
    this.emitter = new WorkflowEventEmitter(deps.eventBus);
    this.sessionStore = deps.sessionStore;
    this.orchestratorAgent = deps.orchestratorAgent;
    this.config = deps.config;
  }

  /** This workflow is triggered explicitly, not via EventBus subscription. */
  start(): void {
    // No-op: this workflow is invoked directly via run()
  }

  stop(): void {
    // No-op
  }

  /**
   * Run the full pipeline for a session.
   * Throws on fatal errors after emitting appropriate events.
   */
  async run(input: PipelineInput): Promise<void> {
    const { session, issue, projectPath, baseBranch } = input;
    const sessionId = session.id;
    const isPromptOnly = issue.number === 0;

    await this.emitter.emit('session.started' as any, sessionId);

    // Step 1: Plan
    const plan = await this.runPlanning(sessionId, issue, projectPath);
    this.sessionStore.update(sessionId, (s) => s.setPlan(plan));
    await this.emitter.emit('session.plan_ready', sessionId, { sessionId, plan: plan as any });

    logger.info(
      { sessionId, summary: plan.summary, complexity: plan.estimated_complexity },
      'Pipeline: plan ready',
    );

    // Step 2: Create worktree + branch
    const branchPrefix = isPromptOnly ? 'prompt' : `issue/${issue.number}`;
    const branchName = `${branchPrefix}/${slugify(issue.title)}-${nanoid(5)}`;
    const { createWorktree } = await import('@funny/core/git');

    const wtResult = await createWorktree(projectPath, branchName, baseBranch);
    if (wtResult.isErr()) {
      logger.error({ err: wtResult.error }, 'Failed to create worktree');
      await this.emitFatalError(sessionId, `Worktree creation failed: ${wtResult.error}`);
      return;
    }

    const worktreePath = wtResult.value;
    this.sessionStore.update(sessionId, (s) => s.setBranch(branchName, worktreePath));
    await this.sessionStore.transition(sessionId, 'implementing');

    logger.info({ sessionId, branch: branchName, worktreePath }, 'Pipeline: implementing');

    // Step 3: Implement
    const implResult = await this.runImplementation(
      sessionId,
      issue,
      plan,
      worktreePath,
      branchName,
    );

    if (implResult.status === 'error') {
      const errorDetail =
        implResult.findings_count > 0
          ? `Implementation failed with ${implResult.findings_count} finding(s)`
          : 'Implementation failed';
      logger.error({ sessionId, status: implResult.status }, errorDetail);
      await this.emitFatalError(sessionId, errorDetail);
      return;
    }

    logger.info(
      { sessionId, status: implResult.status, findings: implResult.findings_count },
      'Pipeline: implementation complete',
    );

    // Step 4: Commit changes
    const { push, createPR, execute: gitExec } = await import('@funny/core/git');
    const { executeShell } = await import('@funny/core/git');
    const identity = process.env.GH_TOKEN ? { githubToken: process.env.GH_TOKEN } : undefined;

    const statusResult = await gitExec('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      reject: false,
    });
    if (statusResult.stdout.trim().length > 0) {
      logger.info({ sessionId }, 'Committing implementation changes');
      const commitMsg = isPromptOnly
        ? `feat: ${issue.title}`
        : `fix: ${issue.title} (Closes #${issue.number})`;
      await executeShell(`git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
        cwd: worktreePath,
        reject: false,
      });
    }

    // Step 5: Push + create PR
    const countResult = await gitExec('git', ['rev-list', '--count', `${baseBranch}..HEAD`], {
      cwd: worktreePath,
      reject: false,
    });
    const commitsAhead = parseInt(countResult.stdout.trim(), 10) || 0;

    if (commitsAhead === 0) {
      logger.warn({ sessionId }, 'No commits on branch — skipping push/PR');
      await this.emitFatalError(
        sessionId,
        'Implementation produced no commits. Nothing to push or create a PR for.',
      );
      return;
    }

    const pushResult = await push(worktreePath, identity);
    if (pushResult.isErr()) {
      logger.error({ err: pushResult.error }, 'Failed to push branch');
      await this.emitFatalError(sessionId, `Push failed: ${pushResult.error}`);
      return;
    }

    await this.sessionStore.transition(sessionId, 'pr_created');

    const prTitle = isPromptOnly
      ? `feat: ${issue.title}`
      : `fix: ${issue.title} (Closes #${issue.number})`;
    const prBody = `## Summary\n\n${plan.summary}\n\n## Approach\n\n${plan.approach}\n\n---\n\nAutomated by funny agent session \`${sessionId}\``;

    const prResult = await createPR(worktreePath, prTitle, prBody, baseBranch, identity);

    if (prResult.isOk()) {
      const prUrl = prResult.value;
      const prNumber = parseInt(prUrl.split('/').pop() ?? '0', 10);
      this.sessionStore.update(sessionId, (s) => s.setPR(prNumber, prUrl));
      logger.info({ sessionId, prNumber, prUrl }, 'Pipeline: PR created');
    } else {
      logger.warn(
        { err: prResult.error },
        'PR creation failed — session still tracks the pushed branch',
      );
      await this.emitError(
        sessionId,
        `PR creation failed: ${prResult.error}. Branch was pushed but PR could not be created.`,
      );
    }

    // Transition to waiting for CI
    await this.sessionStore.transition(sessionId, 'ci_running');

    // Emit completed
    const issueLabel = isPromptOnly ? issue.title : `#${issue.number}: ${issue.title}`;
    const completionData: Record<string, string> = {
      result: prResult.isOk()
        ? `PR created for ${issueLabel}`
        : `Branch pushed for ${issueLabel} (PR creation failed)`,
    };
    if (prResult.isErr()) {
      completionData.error_message = `Error: PR creation failed: ${prResult.error}. Branch was pushed but PR could not be created.`;
    }
    await this.emitter.emit('session.completed' as any, sessionId, completionData);

    logger.info({ sessionId }, 'Pipeline: complete, waiting for CI/review');
  }

  // ── Private helpers ────────────────────────────────────────────

  private async runPlanning(
    sessionId: string,
    issue: IssueDetail,
    projectPath: string,
  ): Promise<ImplementationPlan> {
    logger.info({ sessionId }, 'Pipeline: planning');

    return this.orchestratorAgent.planIssue(issue, projectPath, {
      onEvent: async (event) => {
        switch (event.type) {
          case 'text':
            await this.emitter.emit('session.plan_ready' as any, sessionId, {
              role: 'assistant',
              content: event.content,
            });
            break;
          case 'tool_call':
            await this.emitter.emit('session.tool_call', sessionId, {
              tool_name: event.name,
              tool_input: event.args,
              tool_call_id: event.id,
            });
            break;
          case 'tool_result':
            await this.emitter.emit('session.tool_result', sessionId, {
              tool_call_id: event.id,
              output: event.result,
            });
            break;
          case 'error':
            await this.emitError(sessionId, event.message);
            break;
        }
      },
    });
  }

  private async runImplementation(
    sessionId: string,
    issue: IssueDetail,
    plan: ImplementationPlan,
    worktreePath: string,
    branchName: string,
  ) {
    return this.orchestratorAgent.implementIssue(issue, plan, worktreePath, branchName, {
      onEvent: async (event) => {
        switch (event.type) {
          case 'text':
            await this.emitter.emit('session.message' as any, sessionId, {
              role: 'assistant',
              content: event.content,
            });
            break;
          case 'tool_call':
            await this.emitter.emit('session.tool_call', sessionId, {
              tool_name: event.name,
              tool_input: event.args,
              tool_call_id: event.id,
            });
            break;
          case 'tool_result':
            await this.emitter.emit('session.tool_result', sessionId, {
              tool_call_id: event.id,
              output: event.result,
            });
            break;
          case 'error':
            await this.emitError(sessionId, event.message);
            break;
        }
      },
    });
  }

  private async emitError(sessionId: string, message: string): Promise<void> {
    await this.emitter.emit('session.message' as any, sessionId, {
      role: 'assistant',
      content: `Error: ${message}`,
    });
  }

  private async emitFatalError(sessionId: string, message: string): Promise<void> {
    await this.emitError(sessionId, message);
    await this.sessionStore.transition(sessionId, 'failed', { error: message });
    await this.emitter.emit('session.failed' as any, sessionId, {
      error: message,
      error_message: `Error: ${message}`,
    });
  }
}

/** Convert issue title to a git-branch-friendly slug */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}
