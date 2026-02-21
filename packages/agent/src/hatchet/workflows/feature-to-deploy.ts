/**
 * feature-to-deploy — Hatchet workflow for the full feature lifecycle.
 *
 * Orchestrates: classify complexity → create worktree → implement feature →
 * quality pipeline → wait for pipeline → (Director+Integrator via EventBus) →
 * wait for PR approval → deploy.
 *
 * Steps that involve LLM agents use AgentExecutor directly.
 * Steps that interact with existing services use HTTP API calls.
 * Director and Integrator continue to fire via EventBus (not Hatchet steps).
 */

import type { HatchetClient, DurableContext } from '@hatchet-dev/typescript-sdk/v1';
import { execute } from '@funny/core/git';
import { AgentExecutor, ModelFactory } from '@funny/core/agents';
import type { AgentRole, AgentContext } from '@funny/core/agents';
import { logger } from '../../infrastructure/logger.js';

// ── Input/Output types ──────────────────────────────────────────

interface FeatureToDeployInput {
  userPrompt: string;
  projectPath: string;
  branch?: string;
  model?: string;
  provider?: string;
}

interface ComplexityOutput {
  complexity: string;
  estimated_files: number;
  recommended_agents: string[];
}

interface WorktreeOutput {
  worktreePath: string;
  branch: string;
}

interface PipelineOutput {
  request_id: string;
}

interface PipelineStatusOutput {
  status: string;
  result: Record<string, unknown>;
}

interface ApprovalOutput {
  approved: boolean;
}

interface DeployOutput {
  deployed: boolean;
  deployed_at: string;
}

type WorkflowOutput = {
  'classify-complexity': ComplexityOutput;
  'create-worktree': WorktreeOutput;
  'implement-feature': Record<string, unknown>;
  'quality-pipeline': PipelineOutput;
  'wait-for-pipeline': PipelineStatusOutput;
  'wait-for-approval': ApprovalOutput;
  'deploy': DeployOutput;
};

// ── Workflow registration ───────────────────────────────────────

export function registerFeatureToDeployWorkflow(hatchet: HatchetClient) {
  const workflow = hatchet.workflow<FeatureToDeployInput, WorkflowOutput>({
    name: 'feature-to-deploy',
  });

  // Step 1: Classify complexity using an LLM agent
  const classifyComplexity = workflow.task({
    name: 'classify-complexity',
    executionTimeout: '5m',
    retries: 1,
    fn: async (input) => {
      const { userPrompt, projectPath } = input;

      const role: AgentRole = {
        name: 'complexity-classifier',
        systemPrompt: `You are a complexity analysis agent. Analyze the user's feature request and determine:
1. Complexity: small, medium, or large
2. Estimated number of files that will change
3. Which quality agents should run (from: tests, security, architecture, performance, style, types, docs, integration)

Output your analysis as JSON:
\`\`\`json
{
  "complexity": "small" | "medium" | "large",
  "estimated_files": <number>,
  "recommended_agents": ["tests", ...]
}
\`\`\``,
        model: input.model ?? 'claude-sonnet-4-5-20250929',
        provider: input.provider ?? 'anthropic',
        tools: [],
        maxTurns: 5,
      };

      const context: AgentContext = {
        branch: 'main',
        worktreePath: projectPath,
        tier: 'medium',
        diffStats: { files_changed: 0, lines_added: 0, lines_deleted: 0, changed_files: [] },
        previousResults: [],
        baseBranch: 'main',
      };

      const modelFactory = new ModelFactory();
      const model = modelFactory.create(role.provider, role.model);
      const executor = new AgentExecutor(model);
      const result = await executor.execute(role, context);

      // Parse the result as complexity output
      const finding = result.findings[0];
      if (finding?.description) {
        try {
          const jsonMatch = finding.description.match(/```json\s*([\s\S]*?)\s*```/) ??
            finding.description.match(/(\{[\s\S]*"complexity"[\s\S]*\})/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as ComplexityOutput;
          }
        } catch { /* fall through */ }
      }

      // Default classification
      return {
        complexity: 'medium',
        estimated_files: 10,
        recommended_agents: ['tests', 'security', 'architecture'],
      } as ComplexityOutput;
    },
  });

  // Step 2: Create a worktree for the feature
  const createWorktree = workflow.task({
    name: 'create-worktree',
    parents: [classifyComplexity],
    executionTimeout: '2m',
    fn: async (input, ctx) => {
      const { projectPath } = input;
      const branch = input.branch ?? `feature/${Date.now()}`;
      const worktreePath = `${projectPath}/.funny-worktrees/${branch.replace(/\//g, '-')}`;

      await execute('git', ['worktree', 'add', '-b', branch, worktreePath], {
        cwd: projectPath,
      });

      logger.info({ branch, worktreePath }, 'Worktree created for feature');

      return { worktreePath, branch } as WorktreeOutput;
    },
  });

  // Step 3: Implement the feature using an LLM agent
  const implementFeature = workflow.task({
    name: 'implement-feature',
    parents: [createWorktree],
    executionTimeout: '30m',
    retries: 1,
    fn: async (input, ctx) => {
      const worktreeResult = await ctx.parentOutput(createWorktree);

      const role: AgentRole = {
        name: 'implementer',
        systemPrompt: `You are a software implementation agent. Implement the requested feature in the codebase.

## Instructions
1. Understand the feature request
2. Read the relevant existing code
3. Implement the feature with clean, well-tested code
4. Commit your changes

When finished, output a JSON summary:
\`\`\`json
{
  "status": "passed",
  "findings": [{ "severity": "info", "description": "Implementation summary...", "fix_applied": true }],
  "fixes_applied": 1
}
\`\`\``,
        model: input.model ?? 'claude-sonnet-4-5-20250929',
        provider: input.provider ?? 'anthropic',
        tools: [],
        maxTurns: 200,
      };

      const context: AgentContext = {
        branch: worktreeResult.branch,
        worktreePath: worktreeResult.worktreePath,
        tier: 'large',
        diffStats: { files_changed: 0, lines_added: 0, lines_deleted: 0, changed_files: [] },
        previousResults: [],
        baseBranch: 'main',
      };

      const modelFactory = new ModelFactory();
      const model = modelFactory.create(role.provider, role.model);
      const executor = new AgentExecutor(model);
      const result = await executor.execute(role, context);

      return { status: result.status, agent: result.agent, findings_count: result.findings.length };
    },
  });

  // Step 4: Trigger the quality pipeline via internal API
  const qualityPipeline = workflow.task({
    name: 'quality-pipeline',
    parents: [implementFeature],
    executionTimeout: '5m',
    fn: async (input, ctx) => {
      const worktreeResult = await ctx.parentOutput(createWorktree);
      const complexityResult = await ctx.parentOutput(classifyComplexity);

      const requestId = `hatchet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const port = process.env.PORT ?? '3002';

      const response = await fetch(`http://localhost:${port}/pipeline/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          branch: worktreeResult.branch,
          worktree_path: worktreeResult.worktreePath,
          config: {
            agents: complexityResult.recommended_agents,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Pipeline trigger failed: ${response.status} ${await response.text()}`);
      }

      return { request_id: requestId } as PipelineOutput;
    },
  });

  // Step 5: Poll pipeline status until terminal state
  const waitForPipeline = workflow.task({
    name: 'wait-for-pipeline',
    parents: [qualityPipeline],
    executionTimeout: '60m',
    fn: async (input, ctx) => {
      const pipelineResult = await ctx.parentOutput(qualityPipeline);
      const port = process.env.PORT ?? '3002';

      // Poll with exponential backoff
      let delay = 5_000;
      const maxDelay = 30_000;

      for (let attempt = 0; attempt < 360; attempt++) { // max ~60 min
        if (ctx.cancelled) throw new Error('Cancelled');

        const response = await fetch(`http://localhost:${port}/pipeline/${pipelineResult.request_id}`);
        if (response.ok) {
          const status = await response.json() as any;

          if (status.status === 'approved') {
            return { status: 'approved', result: status } as PipelineStatusOutput;
          }
          if (status.status === 'failed' || status.status === 'error') {
            throw new Error(`Pipeline ${status.status}: ${JSON.stringify(status)}`);
          }
        }

        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, maxDelay);
      }

      throw new Error('Pipeline timeout after 60 minutes');
    },
  });

  // Steps 6-7: Director + Integrator fire automatically via EventBus
  // (pipeline.completed → ManifestWriter → Director → Integrator → PR)
  // No Hatchet step needed — these are reactive EventBus handlers.

  // Step 8: Wait for human PR approval (durable — survives restarts)
  const waitForApproval = workflow.durableTask({
    name: 'wait-for-approval',
    parents: [waitForPipeline],
    executionTimeout: '168h', // 7 days
    fn: async (input, ctx: DurableContext<FeatureToDeployInput>) => {
      const result = await ctx.waitFor({
        eventKey: 'pr.approved',
      });

      logger.info({ result }, 'PR approval received');

      return { approved: true } as ApprovalOutput;
    },
  });

  // Step 9: Deploy after approval
  const deploy = workflow.task({
    name: 'deploy',
    parents: [waitForApproval],
    executionTimeout: '10m',
    retries: 2,
    fn: async (input, ctx) => {
      const worktreeResult = await ctx.parentOutput(createWorktree);

      // Merge the PR (squash merge)
      await execute('gh', ['pr', 'merge', '--squash', '--head', worktreeResult.branch], {
        cwd: input.projectPath,
      });

      logger.info({ branch: worktreeResult.branch }, 'Feature deployed');

      return { deployed: true, deployed_at: new Date().toISOString() } as DeployOutput;
    },
  });

  return workflow;
}
