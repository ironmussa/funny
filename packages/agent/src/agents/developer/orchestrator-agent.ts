/**
 * OrchestratorAgent — the "brain" that plans issue implementation.
 *
 * An LLM agent that:
 * - Reads an issue + codebase context
 * - Creates an implementation plan (files to modify, approach, risks)
 * - Decides if the issue needs decomposition into sub-tasks
 *
 * For planning: makes a direct LLM call (no AgentExecutor) to avoid
 * the executor's own output-format instructions conflicting with the
 * planner's JSON schema.
 *
 * For implementing: uses AgentExecutor which provides tools (bash, read,
 * edit, glob, grep) for the coding agent to actually modify files.
 */

import { AgentExecutor, ModelFactory } from '@funny/core/agents';
import type { AgentRole, AgentContext } from '@funny/core/agents';
import { executeShell } from '@funny/core/git';

import type { PipelineServiceConfig } from '../../config/schema.js';
import type { ImplementationPlan } from '../../core/session.js';
import { logger } from '../../infrastructure/logger.js';
import type { IssueDetail } from '../../trackers/tracker.js';

// ── Planner event types ─────────────────────────────────────────

export type PlannerEvent =
  | { type: 'text'; content: string; step: number }
  | { type: 'tool_call'; name: string; args: Record<string, any>; id: string; step: number }
  | { type: 'tool_result'; id: string; name: string; result: string; step: number }
  | { type: 'plan_ready'; plan: ImplementationPlan }
  | { type: 'error'; message: string };

// ── Planning prompt ──────────────────────────────────────────────

function buildPlanningPrompt(issue: IssueDetail, projectPath: string): string {
  const heading =
    issue.number === 0 ? `## Task: ${issue.title}` : `## Issue #${issue.number}: ${issue.title}`;

  return `You are a senior software architect analyzing a task to create an implementation plan.

${heading}

${issue.fullContext}

## Your Task

Analyze this task and the codebase to create a detailed implementation plan.

1. **Explore the codebase** — Use the tools to understand the existing architecture
2. **Identify relevant files** — Find files that need to be modified or created
3. **Design the approach** — Determine the best way to implement this
4. **Assess complexity** — Estimate if this is small, medium, or large
5. **Identify risks** — What could go wrong? Are there edge cases?

## CRITICAL: Output Format

After your analysis, you MUST output your plan as a JSON block wrapped in triple backticks.
This is the ONLY output format you should use. Do NOT use any other JSON structure.

\`\`\`json
{
  "summary": "One-line summary of what needs to be done",
  "approach": "Detailed description of the implementation approach (2-5 sentences)",
  "files_to_modify": ["path/to/file1.ts", "path/to/file2.ts"],
  "files_to_create": ["path/to/new-file.ts"],
  "estimated_complexity": "small",
  "risks": ["Risk 1", "Risk 2"],
  "sub_tasks": ["Sub-task 1 (optional)", "Sub-task 2 (optional)"]
}
\`\`\`

Note: estimated_complexity must be one of: "small", "medium", or "large".

## Guidelines

- Be specific about which files to modify — don't guess, use grep/glob to verify
- The approach should be concrete enough for another agent to implement
- Mark complexity as:
  - **small**: ≤3 files, straightforward change
  - **medium**: 4-10 files, requires understanding existing patterns
  - **large**: 10+ files or architectural changes
- Only include sub_tasks if the issue genuinely needs decomposition
- Working directory: ${projectPath}`;
}

// ── Implementing prompt ─────────────────────────────────────────

function buildImplementingPrompt(issue: IssueDetail, plan: ImplementationPlan): string {
  const heading =
    issue.number === 0 ? `## Task: ${issue.title}` : `## Issue #${issue.number}: ${issue.title}`;

  return `You are a senior software engineer implementing a feature based on a pre-approved plan.

${heading}

${issue.fullContext}

## Implementation Plan

**Summary:** ${plan.summary}

**Approach:** ${plan.approach}

**Files to modify:** ${plan.files_to_modify.join(', ')}
**Files to create:** ${plan.files_to_create.join(', ')}
**Estimated complexity:** ${plan.estimated_complexity}

${plan.risks.length > 0 ? `**Risks to watch for:**\n${plan.risks.map((r) => `- ${r}`).join('\n')}` : ''}

## Instructions

1. Read the existing code to understand current patterns
2. Implement the changes according to the plan
3. Follow existing code style and conventions
4. Write clean, well-structured code
5. Do NOT run git commit — the pipeline handles committing automatically after you finish

## Important

- Stay on the current branch — do NOT create new branches
- Do NOT run git add, git commit, or git push — the pipeline manages the git lifecycle
- If you encounter something unexpected, adapt the plan sensibly
- If a risk from the plan materializes, handle it gracefully`;
}

// ── OrchestratorAgent ───────────────────────────────────────────

export class OrchestratorAgent {
  private modelFactory: ModelFactory;

  constructor(
    private config: PipelineServiceConfig,
    modelFactory?: ModelFactory,
  ) {
    this.modelFactory = modelFactory ?? new ModelFactory();
  }

  /**
   * Analyze an issue and produce an implementation plan.
   *
   * Uses a direct LLM call (not AgentExecutor) to avoid conflicting
   * output-format instructions. The planner needs its own JSON schema
   * (summary, approach, files) — not the executor's (status, findings).
   */
  async planIssue(
    issue: IssueDetail,
    projectPath: string,
    opts?: {
      signal?: AbortSignal;
      /** Called for each planner step — text output and tool calls */
      onEvent?: (event: PlannerEvent) => void;
    },
  ): Promise<ImplementationPlan> {
    const { orchestrator } = this.config;

    const resolved = this.modelFactory.resolve(orchestrator.provider, orchestrator.model);

    const systemPrompt = buildPlanningPrompt(issue, projectPath);

    const userPrompt = `Analyze this issue and create an implementation plan. Use the tools to explore the codebase at ${projectPath}, then output your plan as a JSON block.`;

    // Direct LLM call via runs endpoint — no AgentExecutor wrapper
    const url = `${resolved.baseURL}/v1/runs`;
    logger.info({ url, model: resolved.modelId }, 'Planning issue with direct LLM call');

    let allText = '';
    let steps = 0;
    const maxTurns = orchestrator.max_planning_turns;

    // Simple tool definitions for exploration
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'bash',
          description: 'Run a shell command. Returns stdout+stderr.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Shell command to execute' },
            },
            required: ['command'],
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'read_file',
          description: 'Read a file. Returns numbered lines.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path' },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'glob',
          description: 'Find files matching a glob pattern.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts")' },
            },
            required: ['pattern'],
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'grep',
          description: 'Search file contents for a pattern.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Search pattern' },
              path: { type: 'string', description: 'Directory to search in (default: ".")' },
              file_glob: { type: 'string', description: 'File filter (e.g., "*.ts")' },
            },
            required: ['pattern'],
          },
        },
      },
    ];

    // Build conversation as text prompt — on subsequent turns we append
    // assistant text + tool results so the model has context.
    const conversationParts: string[] = [userPrompt];

    const { readFileSync, existsSync } = await import('fs');
    const { join } = await import('path');

    while (steps < maxTurns) {
      if (opts?.signal?.aborted) break;

      const prompt = conversationParts.join('\n\n');
      console.log(`[Planner] POST ${url} model=${resolved.modelId} step=${steps}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: resolved.modelId,
          system_prompt: systemPrompt,
          prompt,
          tools,
          max_turns: 1,
        }),
        signal: opts?.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => 'Unknown');
        const errMsg = `LLM call failed (HTTP ${response.status}): ${errBody.slice(0, 300)}`;
        logger.error(
          { status: response.status, body: errBody.slice(0, 300) },
          'Planner LLM call failed',
        );
        opts?.onEvent?.({ type: 'error', message: errMsg });
        throw new Error(errMsg);
      }

      const data = (await response.json()) as any;

      if (data.status === 'failed') {
        const errMsg = `Planner run failed: ${data.error?.message ?? 'Unknown error'}`;
        logger.error({ error: data.error?.message }, 'Planner run failed');
        opts?.onEvent?.({ type: 'error', message: errMsg });
        throw new Error(errMsg);
      }

      const text = data.result?.text ?? '';
      if (text) {
        allText += '\n' + text;
        opts?.onEvent?.({ type: 'text', content: text, step: steps });
      }

      const runToolCalls = data.result?.tool_calls;

      // No tool calls → model is done
      if (!runToolCalls?.length) {
        break;
      }

      // Execute tools locally
      const toolResultParts: string[] = [];
      for (const tc of runToolCalls) {
        const args = JSON.parse(tc.function.arguments);
        opts?.onEvent?.({
          type: 'tool_call',
          name: tc.function.name,
          args,
          id: tc.id,
          step: steps,
        });

        let result: string;
        try {
          switch (tc.function.name) {
            case 'bash': {
              const r = await executeShell(args.command, {
                cwd: projectPath,
                timeout: 30_000,
                reject: false,
              });
              result = [r.stdout, r.stderr ? `stderr: ${r.stderr}` : '', `exit: ${r.exitCode}`]
                .filter(Boolean)
                .join('\n');
              break;
            }
            case 'read_file': {
              const fp = join(projectPath, args.path);
              if (!existsSync(fp)) {
                result = `Error: File not found: ${args.path}`;
              } else {
                const content = readFileSync(fp, 'utf-8');
                const lines = content.split('\n');
                result = lines
                  .slice(0, 200)
                  .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
                  .join('\n');
                if (lines.length > 200) result += `\n... (${lines.length - 200} more lines)`;
              }
              break;
            }
            case 'glob': {
              const g = new Bun.Glob(args.pattern);
              const matches: string[] = [];
              for await (const m of g.scan({ cwd: projectPath, dot: false })) {
                matches.push(m);
                if (matches.length >= 200) break;
              }
              result = matches.join('\n') || 'No files matched.';
              break;
            }
            case 'grep': {
              // Try rg first, fall back to grep -r if rg is not installed.
              const target = args.path ?? '.';
              const globFlag = args.file_glob ? ` --glob '${args.file_glob}'` : '';
              const includeFlag = args.file_glob ? ` --include='${args.file_glob}'` : '';
              const pat = args.pattern.replace(/'/g, "'\\''");
              const cmd = `rg '${pat}' '${target}' --line-number --no-heading --color=never --max-count=50${globFlag} 2>/dev/null || grep -r -n '${pat}' '${target}'${includeFlag} | head -50`;
              const r = await executeShell(cmd, {
                cwd: projectPath,
                timeout: 15_000,
                reject: false,
              });
              result = r.stdout || 'No matches.';
              break;
            }
            default:
              result = `Unknown tool: ${tc.function.name}`;
          }
        } catch (err: any) {
          result = `Error: ${err.message}`;
        }

        opts?.onEvent?.({
          type: 'tool_result',
          id: tc.id,
          name: tc.function.name,
          result: result.slice(0, 2000),
          step: steps,
        });
        toolResultParts.push(`Tool result (${tc.id} / ${tc.function.name}):\n${result}`);
      }

      // Append assistant text + tool results to conversation for next turn
      const assistantPart = text
        ? `Assistant: ${text}\n${runToolCalls.map((tc: any) => `[tool_call: ${tc.function.name}(${tc.function.arguments})]`).join('\n')}`
        : runToolCalls
            .map((tc: any) => `[tool_call: ${tc.function.name}(${tc.function.arguments})]`)
            .join('\n');
      conversationParts.push(assistantPart);
      conversationParts.push(toolResultParts.join('\n\n'));

      steps++;
    }

    // Parse plan from collected text
    const plan = this.extractPlan(allText, opts?.onEvent);
    opts?.onEvent?.({ type: 'plan_ready', plan });

    logger.info(
      {
        issueNumber: issue.number,
        complexity: plan.estimated_complexity,
        files: plan.files_to_modify.length,
      },
      'Issue plan created',
    );

    return plan;
  }

  /**
   * Implement an issue using a coding agent in the given worktree.
   *
   * Uses AgentExecutor which provides tools (bash, read, edit, glob, grep)
   * for the coding agent to modify files and commit.
   */
  async implementIssue(
    issue: IssueDetail,
    plan: ImplementationPlan,
    worktreePath: string,
    branch: string,
    opts?: {
      signal?: AbortSignal;
      onEvent?: (event: PlannerEvent) => void;
    },
  ): Promise<{ status: string; findings_count: number }> {
    const { orchestrator } = this.config;

    const role: AgentRole = {
      name: 'implementer',
      systemPrompt: buildImplementingPrompt(issue, plan),
      model: orchestrator.model,
      provider: orchestrator.provider,
      tools: [],
      maxTurns: orchestrator.max_implementing_turns,
    };

    const context: AgentContext = {
      branch,
      worktreePath,
      tier: plan.estimated_complexity,
      diffStats: { files_changed: 0, lines_added: 0, lines_deleted: 0, changed_files: [] },
      previousResults: [],
      baseBranch: 'main',
    };

    const resolved = this.modelFactory.resolve(role.provider, role.model);
    const executor = new AgentExecutor(resolved.baseURL, resolved.modelId, resolved.apiKey);
    const result = await executor.execute(role, context, {
      signal: opts?.signal,
      onStepFinish: async (step) => {
        if (!opts?.onEvent) return;

        if (step.text) {
          opts.onEvent({ type: 'text', content: step.text, step: step.stepNumber });
        }
        for (const tc of step.toolCalls) {
          opts.onEvent({
            type: 'tool_call',
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments),
            id: tc.id,
            step: step.stepNumber,
          });
        }
        for (const tr of step.toolResults) {
          opts.onEvent({
            type: 'tool_result',
            id: tr.toolCallId,
            name: tr.toolName,
            result: tr.result.slice(0, 2000),
            step: step.stepNumber,
          });
        }
      },
    });

    if (result.status === 'error') {
      const errMsg =
        result.findings.map((f) => f.description).join('; ') || 'Unknown implementation error';
      logger.error({ issueNumber: issue.number, error: errMsg }, 'Issue implementation failed');
      opts?.onEvent?.({ type: 'error', message: errMsg });
    } else {
      logger.info(
        { issueNumber: issue.number, status: result.status, fixes: result.fixes_applied },
        'Issue implementation completed',
      );
    }

    return { status: result.status, findings_count: result.findings.length };
  }

  // ── Plan extraction ───────────────────────────────────────────

  private extractPlan(
    rawText: string,
    onEvent?: (event: PlannerEvent) => void,
  ): ImplementationPlan {
    const plan = this.parsePlanJson(rawText);
    if (plan) return plan;

    // Fallback: return a generic plan
    const msg = 'Could not parse implementation plan from agent output — using fallback plan';
    logger.warn({ textLength: rawText.length, textPreview: rawText.slice(-500) }, msg);
    onEvent?.({ type: 'error', message: msg });
    return {
      summary: 'Implementation plan could not be parsed from agent output',
      approach: 'Manual review needed',
      files_to_modify: [],
      files_to_create: [],
      estimated_complexity: 'medium',
      risks: ['Plan extraction failed — may need human guidance'],
    };
  }

  private parsePlanJson(text: string): ImplementationPlan | null {
    try {
      // Try JSON in code block first (most common)
      const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        const raw = JSON.parse(codeBlockMatch[1]);
        if (raw.summary && raw.approach) {
          return this.normalizeplan(raw);
        }
      }

      // Try bare JSON with plan keys
      const bareMatch = text.match(/\{[\s\S]*?"summary"\s*:\s*"[\s\S]*?"approach"\s*:[\s\S]*?\}/);
      if (bareMatch) {
        const raw = JSON.parse(bareMatch[0]);
        return this.normalizeplan(raw);
      }

      return null;
    } catch {
      return null;
    }
  }

  private normalizeplan(raw: any): ImplementationPlan {
    return {
      summary: raw.summary ?? '',
      approach: raw.approach ?? '',
      files_to_modify: Array.isArray(raw.files_to_modify) ? raw.files_to_modify : [],
      files_to_create: Array.isArray(raw.files_to_create) ? raw.files_to_create : [],
      estimated_complexity: ['small', 'medium', 'large'].includes(raw.estimated_complexity)
        ? raw.estimated_complexity
        : 'medium',
      risks: Array.isArray(raw.risks) ? raw.risks : [],
      sub_tasks: Array.isArray(raw.sub_tasks) ? raw.sub_tasks : undefined,
    };
  }
}
