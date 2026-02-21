/**
 * AgentExecutor — runs an agentic loop using the Vercel AI SDK.
 *
 * Uses `generateText` with `maxSteps` for automatic tool calling:
 *   1. Send system prompt + context + user prompt to the LLM
 *   2. AI SDK handles tool calls automatically (up to maxSteps)
 *   3. Parse final text as structured AgentResult JSON
 *
 * Replaces the manual agentic loop with AI SDK's built-in loop.
 */

import { generateText, tool, type LanguageModel, type StepResult } from 'ai';
import { z } from 'zod';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execute } from '../../git/process.js';
import type { AgentRole, AgentContext, AgentResult, Finding } from './agent-context.js';
import { createBrowserTools, type BrowserToolsHandle } from './browser-tools.js';
import { loadContextDocs } from './context-loader.js';

// ── Options ───────────────────────────────────────────────────

export interface AgentExecutorOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Callback fired after each step (tool call + result) */
  onStepFinish?: (step: StepResult<any>) => void;
}

// ── Executor ──────────────────────────────────────────────────

export class AgentExecutor {
  constructor(private model: LanguageModel) {}

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

    try {
      const result = await generateText({
        model: this.model,
        system: this.buildSystemPrompt(role, context, projectKnowledge),
        prompt: this.buildUserPrompt(context),
        tools,
        maxSteps: role.maxTurns,
        temperature: role.temperature,
        maxTokens: role.maxTokens,
        abortSignal: options.signal,
        onStepFinish: options.onStepFinish,
      });

      // Parse the final text output as AgentResult
      return this.parseResult(role, result.text, startTime, result.steps.length, result.usage);
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

// ── Tool Definitions (AI SDK format) ──────────────────────────

interface ToolsResult {
  tools: Record<string, ReturnType<typeof tool>>;
  browserHandle: BrowserToolsHandle | null;
}

function createTools(cwd: string, role: AgentRole, context: AgentContext): ToolsResult {
  let browserHandle: BrowserToolsHandle | null = null;

  const baseTools: Record<string, ReturnType<typeof tool>> = {
    bash: tool({
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
    }),

    read: tool({
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
    }),

    edit: tool({
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
    }),

    glob: tool({
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
    }),

    grep: tool({
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
    }),
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
