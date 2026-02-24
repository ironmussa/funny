/**
 * AgentExecutor — runs an agentic loop via direct HTTP calls to api-acp.
 *
 * Loop:
 *   1. Send system prompt + prompt to api-acp /v1/runs
 *   2. If run result contains tool_calls → execute tools locally → build new prompt
 *   3. Repeat until no tool_calls or maxTurns reached
 *   4. Parse final text as structured AgentResult JSON
 *
 * Uses the agent run protocol (POST /v1/runs) instead of OpenAI format.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execute } from '../../git/process.js';
import type { AgentRole, AgentContext, AgentResult, Finding } from './agent-context.js';
import { createBrowserTools, type BrowserToolsHandle } from './browser-tools.js';
import { loadContextDocs } from './context-loader.js';

// ── Types ────────────────────────────────────────────────────

/** Tool call from run result */
interface ToolCallInfo {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Run result from the agent API */
interface RunResult {
  text: string;
  tool_calls?: ToolCallInfo[];
}

/** Run response from POST /v1/runs */
interface RunResponse {
  id: string;
  status: string;
  model: string;
  created_at: number;
  completed_at?: number;
  usage?: { input_tokens: number; output_tokens: number };
  result?: RunResult;
  error?: { message: string };
}

/** Tool result after local execution */
export interface ToolResult {
  toolCallId: string;
  toolName: string;
  result: string;
}

/** Step data passed to onStepFinish callback */
export interface StepInfo {
  stepNumber: number;
  text: string;
  toolCalls: ToolCallInfo[];
  toolResults: ToolResult[];
  finishReason: string;
}

/** A plain tool definition (no Vercel AI SDK dependency) */
export interface ToolDef {
  description: string;
  parameters: z.ZodType<any>;
  execute: (args: any) => Promise<string>;
}

// ── Options ───────────────────────────────────────────────────

export interface AgentExecutorOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Callback fired after each step (LLM call + tool execution). May return a Promise. */
  onStepFinish?: (step: StepInfo) => Promise<void> | void;
}

// ── Executor ──────────────────────────────────────────────────

export class AgentExecutor {
  constructor(
    private baseURL: string,
    private modelId: string,
    private apiKey?: string,
  ) {}

  async execute(
    role: AgentRole,
    context: AgentContext,
    options: AgentExecutorOptions = {},
  ): Promise<AgentResult> {
    const startTime = Date.now();

    const { tools, browserHandle } = createTools(context.worktreePath, role, context);

    // Load project-specific docs for progressive disclosure
    let projectKnowledge = '';
    if (role.contextDocs && role.contextDocs.length > 0) {
      projectKnowledge = await loadContextDocs({
        cwd: context.worktreePath,
        patterns: role.contextDocs,
      });
    }

    // Build tool map and run-format definitions
    const toolMap: Record<string, ToolDef> = tools;
    const runTools = Object.entries(tools).map(([name, def]) => ({
      type: 'function' as const,
      function: {
        name,
        description: def.description,
        parameters: zodToJsonSchema(def.parameters),
      },
    }));

    const systemPrompt = this.buildSystemPrompt(role, context, projectKnowledge);

    // Build conversation history as text prompt.
    // On the first turn it's just the user prompt; on subsequent turns
    // we append assistant text + tool results so the model has context.
    const conversationParts: string[] = [this.buildUserPrompt(context)];

    let steps = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastText = '';

    try {
      while (steps < role.maxTurns) {
        if (options.signal?.aborted) {
          return this.makeErrorResult(role, startTime, 'Aborted');
        }

        // Call api-acp runs endpoint
        const url = `${this.baseURL}/v1/runs`;
        const prompt = conversationParts.join('\n\n');
        console.log(`[AgentExecutor] POST ${url} model=${this.modelId} tools=${runTools.length} step=${steps}`);
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.modelId,
            system_prompt: systemPrompt,
            prompt,
            tools: runTools.length > 0 ? runTools : undefined,
            max_turns: 1,
          }),
          signal: options.signal,
        });

        if (!response.ok) {
          const errBody = await response.text().catch(() => 'Unknown error');
          console.error(`[AgentExecutor] ERROR ${response.status} from ${url}: ${errBody.slice(0, 500)}`);
          throw new Error(`api-acp returned ${response.status}: ${errBody}`);
        }

        const data = await response.json() as RunResponse;

        if (data.status === 'failed') {
          throw new Error(data.error?.message ?? 'Run failed');
        }

        // Track tokens
        if (data.usage) {
          totalInputTokens += data.usage.input_tokens ?? 0;
          totalOutputTokens += data.usage.output_tokens ?? 0;
        }

        const assistantText = data.result?.text ?? '';
        lastText = assistantText;
        const runToolCalls = data.result?.tool_calls;

        // If no tool calls → done
        if (!runToolCalls?.length) {
          steps++;
          await options.onStepFinish?.({
            stepNumber: steps,
            text: assistantText,
            toolCalls: [],
            toolResults: [],
            finishReason: 'stop',
          });
          break;
        }

        // Execute tools locally
        const toolResults: ToolResult[] = [];
        const toolResultParts: string[] = [];
        for (const tc of runToolCalls) {
          const toolName = tc.function.name;
          const toolDef = toolMap[toolName];

          let result: string;
          if (!toolDef) {
            result = `Error: Unknown tool "${toolName}"`;
          } else {
            try {
              const args = JSON.parse(tc.function.arguments);
              result = await toolDef.execute(args);
            } catch (err: any) {
              result = `Error executing ${toolName}: ${err.message}`;
            }
          }

          toolResults.push({ toolCallId: tc.id, toolName, result });
          toolResultParts.push(`Tool result (${tc.id} / ${toolName}):\n${result}`);
        }

        // Append assistant text + tool results to conversation for next turn
        const assistantPart = assistantText
          ? `Assistant: ${assistantText}\n${runToolCalls.map((tc) => `[tool_call: ${tc.function.name}(${tc.function.arguments})]`).join('\n')}`
          : runToolCalls.map((tc) => `[tool_call: ${tc.function.name}(${tc.function.arguments})]`).join('\n');
        conversationParts.push(assistantPart);
        conversationParts.push(toolResultParts.join('\n\n'));

        steps++;

        // Fire onStepFinish with BOTH toolCalls AND toolResults
        await options.onStepFinish?.({
          stepNumber: steps,
          text: assistantText,
          toolCalls: runToolCalls,
          toolResults,
          finishReason: 'tool-calls',
        });
      }

      // Parse the final text output as AgentResult
      return this.parseResult(role, lastText, startTime, steps, {
        promptTokens: totalInputTokens,
        completionTokens: totalOutputTokens,
      });
    } catch (err: any) {
      if (options.signal?.aborted) {
        return this.makeErrorResult(role, startTime, 'Aborted');
      }
      return this.makeErrorResult(role, startTime, err.message);
    } finally {
      if (browserHandle) {
        await browserHandle.dispose();
      }
    }
  }

  // ── Prompt construction ─────────────────────────────────────

  private buildSystemPrompt(role: AgentRole, context: AgentContext, projectKnowledge = ''): string {
    const previousContext =
      context.previousResults.length > 0
        ? `\n\n## Previous Agent Results\n${context.previousResults
            .map(
              (r) =>
                `- **${r.agent}**: ${r.status} (${r.findings.length} findings, ${r.fixes_applied} fixes)`,
            )
            .join('\n')}`
        : '';

    return `${role.systemPrompt}
${projectKnowledge}
## Working Context
- Branch: ${context.branch}
- Base branch: ${context.baseBranch}
- Working directory: ${context.worktreePath}
- Tier: ${context.tier}
- Files changed: ${context.diffStats.files_changed}
- Lines: +${context.diffStats.lines_added} -${context.diffStats.lines_deleted}
${previousContext}

## Output Format
When you are finished, output your findings as a JSON object with this structure:
\`\`\`json
{
  "status": "passed" | "failed",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "description": "...",
      "file": "path/to/file.ts",
      "line": 42,
      "fix_applied": true,
      "fix_description": "..."
    }
  ],
  "fixes_applied": 0
}
\`\`\``;
  }

  private buildUserPrompt(context: AgentContext): string {
    const files = context.diffStats.changed_files.slice(0, 50).join('\n- ');
    return `Review the changes on branch \`${context.branch}\` (compared to \`${context.baseBranch}\`).

Changed files:
- ${files}

Run your analysis and report findings. If you can fix issues, apply fixes and report them.`;
  }

  // ── Result parsing ──────────────────────────────────────────

  private parseResult(
    role: AgentRole,
    text: string,
    startTime: number,
    stepsUsed: number,
    usage: { promptTokens: number; completionTokens: number },
  ): AgentResult {
    const metadata = {
      duration_ms: Date.now() - startTime,
      turns_used: stepsUsed,
      tokens_used: { input: usage.promptTokens, output: usage.completionTokens },
      model: role.model,
      provider: role.provider,
    };

    // Try to extract JSON from the text (fenced or raw)
    const jsonMatch =
      text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*"status"[\s\S]*\})/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
        return {
          agent: role.name,
          status: parsed.status ?? 'passed',
          findings: (parsed.findings ?? []).map(normalizeFinding),
          fixes_applied: parsed.fixes_applied ?? 0,
          metadata,
        };
      } catch {
        // Fall through to unstructured result
      }
    }

    // Unstructured result — wrap as info finding
    return {
      agent: role.name,
      status: 'passed',
      findings: text.trim()
        ? [{ severity: 'info', description: text.trim(), fix_applied: false }]
        : [],
      fixes_applied: 0,
      metadata,
    };
  }

  private makeErrorResult(role: AgentRole, startTime: number, message: string): AgentResult {
    return {
      agent: role.name,
      status: 'error',
      findings: [{ severity: 'critical', description: message, fix_applied: false }],
      fixes_applied: 0,
      metadata: {
        duration_ms: Date.now() - startTime,
        turns_used: 0,
        tokens_used: { input: 0, output: 0 },
        model: role.model,
        provider: role.provider,
      },
    };
  }
}

// ── Tool Definitions ─────────────────────────────────────────

interface ToolsResult {
  tools: Record<string, ToolDef>;
  browserHandle: BrowserToolsHandle | null;
}

function createTools(cwd: string, role: AgentRole, context: AgentContext): ToolsResult {
  let browserHandle: BrowserToolsHandle | null = null;

  const baseTools: Record<string, ToolDef> = {
    bash: {
      description: 'Run a shell command in the working directory. Returns stdout, stderr, and exit code.',
      parameters: z.object({
        command: z.string().describe('The shell command to execute'),
        timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
      }),
      execute: async ({ command, timeout }) => {
        const result = await execute('sh', ['-c', command], {
          cwd,
          timeout: timeout ?? 30_000,
          reject: false,
        });
        const parts: string[] = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
        parts.push(`exit_code: ${result.exitCode}`);
        return parts.join('\n');
      },
    },

    read: {
      description: 'Read a file. Returns numbered lines.',
      parameters: z.object({
        path: z.string().describe('Relative file path to read'),
        offset: z.number().optional().describe('Line number to start reading from (1-indexed)'),
        limit: z.number().optional().describe('Maximum number of lines to read'),
      }),
      execute: async ({ path: relPath, offset, limit }) => {
        const filePath = join(cwd, relPath);
        if (!existsSync(filePath)) {
          return `Error: File not found: ${relPath}`;
        }
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const start = (offset ?? 1) - 1;
        const count = limit ?? lines.length;
        const slice = lines.slice(start, start + count);
        return slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n');
      },
    },

    edit: {
      description: 'Edit a file by replacing an exact string match.',
      parameters: z.object({
        path: z.string().describe('Relative file path to edit'),
        old_text: z.string().describe('Exact text to find (must match exactly)'),
        new_text: z.string().describe('Replacement text'),
      }),
      execute: async ({ path: relPath, old_text, new_text }) => {
        const filePath = join(cwd, relPath);
        if (!existsSync(filePath)) {
          return `Error: File not found: ${relPath}`;
        }
        const content = readFileSync(filePath, 'utf-8');
        if (!content.includes(old_text)) {
          return `Error: old_text not found in ${relPath}. Ensure the text matches exactly.`;
        }
        writeFileSync(filePath, content.replace(old_text, new_text), 'utf-8');
        return `Successfully edited ${relPath}`;
      },
    },

    glob: {
      description: 'Find files matching a glob pattern.',
      parameters: z.object({
        pattern: z.string().describe('Glob pattern (e.g., "**/*.ts")'),
      }),
      execute: async ({ pattern }) => {
        const glob = new Bun.Glob(pattern);
        const matches: string[] = [];
        for await (const match of glob.scan({ cwd, dot: false })) {
          matches.push(match);
          if (matches.length >= 500) break;
        }
        return matches.join('\n') || 'No files matched.';
      },
    },

    grep: {
      description: 'Search file contents for a pattern. Returns matching lines with paths and line numbers.',
      parameters: z.object({
        pattern: z.string().describe('Text or regex pattern to search for'),
        path: z.string().optional().describe('Directory or file to search in (relative, default: ".")'),
        file_glob: z.string().optional().describe('File glob filter (e.g., "*.ts")'),
      }),
      execute: async ({ pattern, path: searchPath, file_glob }) => {
        const rgArgs = [pattern, searchPath ?? '.', '--line-number', '--no-heading', '--color=never'];
        if (file_glob) rgArgs.push('--glob', file_glob);

        try {
          const result = await execute('rg', rgArgs, { cwd, timeout: 15_000, reject: false });
          if (result.exitCode === 0) return result.stdout || 'No matches.';
          if (result.exitCode === 1) return 'No matches.';
          throw new Error(result.stderr);
        } catch {
          const grepArgs = ['-r', '-n', pattern, searchPath ?? '.'];
          const result = await execute('grep', grepArgs, { cwd, timeout: 15_000, reject: false });
          return result.stdout || 'No matches.';
        }
      },
    },
  };

  // Merge browser tools if role requests them
  if (role.tools.includes('browser')) {
    const appUrl = context.metadata?.appUrl as string | undefined;
    if (appUrl) {
      browserHandle = createBrowserTools({ appUrl });
      Object.assign(baseTools, browserHandle.tools);
    }
  }

  return { tools: baseTools, browserHandle };
}

// ── Helpers ───────────────────────────────────────────────────

function normalizeFinding(raw: any): Finding {
  return {
    severity: raw.severity ?? 'info',
    description: raw.description ?? '',
    file: raw.file,
    line: raw.line,
    fix_applied: raw.fix_applied ?? false,
    fix_description: raw.fix_description,
  };
}
