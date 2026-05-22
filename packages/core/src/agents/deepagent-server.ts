#!/usr/bin/env node
/**
 * funny Custom Deep Agent Server
 *
 * A custom ACP server that wraps `createDeepAgent` from deepagentsjs with
 * funny-specific defaults for coding tasks. Spawned as a subprocess by
 * `DeepAgentProcess` and communicates via ACP over stdio.
 *
 * Unlike the generic `deepagents-acp` CLI, this server:
 * - Uses `LocalShellBackend` for full filesystem + shell access
 * - Accepts a custom system prompt via env var (DEEPAGENT_SYSTEM_PROMPT)
 * - Loads skills and memory from workspace-relative paths
 * - Includes a coding-oriented default system prompt
 *
 * Usage (spawned by DeepAgentProcess, not called directly):
 *   bun packages/core/src/agents/deepagent-server.ts --model <model> --workspace <dir>
 *
 * Configuration via CLI args:
 *   --model <string>          LLM model to use (e.g. "claude-sonnet-4-5-20250929")
 *   --workspace <string>      Workspace root directory (default: cwd)
 *   --system-prompt <string>  Short system prompt override
 *   --skills <paths>          Comma-separated skill directory paths
 *   --memory <paths>          Comma-separated memory file paths (AGENTS.md)
 *   --name <string>           Agent name (default: "funny-coding-assistant")
 *   --debug                   Enable debug logging to stderr
 *
 * Configuration via env vars:
 *   DEEPAGENT_SYSTEM_PROMPT   Full system prompt (preferred for long prompts)
 *   WORKSPACE_ROOT            Fallback workspace root
 *   DEEPAGENT_SKILLS          Comma-separated skill paths
 *   DEEPAGENT_MEMORY          Comma-separated memory paths
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join as pathJoin } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Directory containing built-in skills shipped with funny */
const BUILTIN_SKILLS_DIR = pathJoin(__dirname, 'deepagent-skills');

// ── CLI arg parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--debug') {
      args.debug = true;
    } else if (arg.startsWith('--') && i + 1 < argv.length) {
      const key = arg.slice(2);
      args[key] = argv[++i];
    }
  }
  return args;
}

const args = parseArgs(process.argv);

const workspaceRoot = (args.workspace as string) || process.env.WORKSPACE_ROOT || process.cwd();

const agentName = (args.name as string) || 'funny-coding-assistant';
const debug = args.debug === true || process.env.DEBUG === 'true';
const model = args.model as string | undefined;

// System prompt: CLI arg → env var → default coding prompt
const systemPrompt =
  (args['system-prompt'] as string) || process.env.DEEPAGENT_SYSTEM_PROMPT || undefined;

// Skills: CLI arg → env var → workspace defaults
function resolvePaths(
  cliValue: string | undefined,
  envVar: string | undefined,
  defaults: string[],
): string[] {
  if (cliValue) return cliValue.split(',').map((p) => p.trim());
  if (envVar) return envVar.split(',').map((p) => p.trim());
  // Filter defaults to only include paths that exist
  return defaults.filter((p) => existsSync(p));
}

const userSkillPaths = resolvePaths(
  args.skills as string | undefined,
  process.env.DEEPAGENT_SKILLS,
  [pathJoin(workspaceRoot, '.deepagents', 'skills'), pathJoin(workspaceRoot, 'skills')],
);

// Built-in skills ship with funny — filter out any disabled via DEEPAGENT_DISABLED_SKILLS env var
const disabledSkills = (process.env.DEEPAGENT_DISABLED_SKILLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let builtinSkillPaths: string[] = [];
if (existsSync(BUILTIN_SKILLS_DIR)) {
  if (disabledSkills.length > 0) {
    // Enumerate subdirectories and exclude disabled ones
    try {
      builtinSkillPaths = readdirSync(BUILTIN_SKILLS_DIR)
        .filter((entry) => {
          const fullPath = pathJoin(BUILTIN_SKILLS_DIR, entry);
          return statSync(fullPath).isDirectory() && !disabledSkills.includes(entry);
        })
        .map((entry) => pathJoin(BUILTIN_SKILLS_DIR, entry));
    } catch {
      builtinSkillPaths = [BUILTIN_SKILLS_DIR];
    }
  } else {
    builtinSkillPaths = [BUILTIN_SKILLS_DIR];
  }
}
const skillPaths = [...builtinSkillPaths, ...userSkillPaths];

const memoryPaths = resolvePaths(args.memory as string | undefined, process.env.DEEPAGENT_MEMORY, [
  pathJoin(workspaceRoot, '.deepagents', 'AGENTS.md'),
  pathJoin(workspaceRoot, 'AGENTS.md'),
]);

// ── Default coding system prompt ─────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are an expert software engineer that solves coding tasks autonomously. You work inside a sandboxed environment with full shell access.

You have access to the workspace at: ${workspaceRoot}

## Workflow

Follow this phased workflow for every task:

### Phase 1: Plan
- Read the issue/task description carefully
- Explore the repository structure to understand the codebase
- Identify relevant files using \`grep\` and \`glob\`
- Write a step-by-step implementation plan using \`write_todos\`
- If the task is ambiguous, ask for clarification before proceeding

### Phase 2: Implement
- Follow your plan step by step
- Write clean, idiomatic code that matches existing patterns
- Run tests after each significant change
- If tests fail, debug and fix before moving on
- Update your todo list as you complete steps

### Phase 3: Review
- Run the full test suite: \`execute("npm test")\` or \`execute("bun test")\`
- Run linters if configured: \`execute("npx eslint .")\`
- Review your own changes: read each modified file end-to-end
- Verify the changes actually solve the original issue
- If anything is wrong, go back to Phase 2

### Phase 4: Deliver
- Commit changes with a clear, descriptive commit message
- Summarize what was done and any decisions made

## Coding Standards

- Match the existing code style — don't introduce new patterns
- Write tests for new functionality
- Keep changes minimal and focused — don't refactor unrelated code
- Add comments only where the logic isn't self-evident
- Handle errors at system boundaries, trust internal code

## Common Patterns

- **Finding files**: Use \`glob("**/*.ts")\` or \`grep("pattern")\` before reading
- **Understanding code**: Read imports, class definitions, and tests first
- **Testing changes**: Always run tests after edits, don't assume correctness
- **Shell commands**: Use \`execute()\` for git, test runners, linters, builds

## Subagents

For complex tasks, delegate to subagents:
- Use \`task(subagent_type="researcher")\` for researching APIs, docs, or patterns
- Use \`task(subagent_type="general-purpose")\` for independent subtasks`;

// ── Start server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Dynamic imports — fail gracefully with clear error messages
  let DeepAgentsServer: any;
  let LocalShellBackend: any;

  try {
    const acpModule = await import('deepagents-acp');
    DeepAgentsServer = acpModule.DeepAgentsServer;
  } catch {
    console.error(
      '[funny-deepagent] Failed to import deepagents-acp.\nInstall it: bun add deepagents-acp',
    );
    process.exit(1);
  }

  try {
    const deepagentsModule = await import('deepagents');
    LocalShellBackend = deepagentsModule.LocalShellBackend;
  } catch {
    console.error('[funny-deepagent] Failed to import deepagents.\nInstall it: bun add deepagents');
    process.exit(1);
  }

  const backend = new LocalShellBackend({
    rootDir: workspaceRoot,
    inheritEnv: true,
  });

  const server = new DeepAgentsServer({
    agents: {
      name: agentName,
      description:
        'AI coding assistant with full filesystem access, shell execution, ' +
        'code search, task management, and subagent delegation capabilities.',
      ...(model ? { model } : {}),
      systemPrompt: systemPrompt || DEFAULT_SYSTEM_PROMPT,
      backend,
      ...(skillPaths.length > 0 ? { skills: skillPaths } : {}),
      ...(memoryPaths.length > 0 ? { memory: memoryPaths } : {}),
    },
    serverName: 'funny-deepagent',
    serverVersion: '1.0.0',
    workspaceRoot,
    debug,
  });

  if (debug) {
    console.error('[funny-deepagent] Starting ACP server...');
    console.error(`[funny-deepagent] Workspace: ${workspaceRoot}`);
    console.error(`[funny-deepagent] Model: ${model ?? 'default'}`);
    console.error(`[funny-deepagent] Skills: ${skillPaths.join(', ') || 'none'}`);
    console.error(`[funny-deepagent] Memory: ${memoryPaths.join(', ') || 'none'}`);
    console.error(`[funny-deepagent] System prompt: ${systemPrompt ? 'custom' : 'default'}`);
  }

  await server.start();
}

main().catch((err) => {
  console.error('[funny-deepagent] Fatal error:', err);
  process.exit(1);
});
