/**
 * Built-in agent definitions and helpers.
 *
 * Centralizes all agent roles (pipeline) into a single registry
 * so every agent's name, prompt, model, provider, and permission mode
 * live together instead of being scattered across context fields.
 */

import type { AgentDefinition, AgentModel, AgentProvider, PermissionMode } from '@funny/shared';

// ── resolve helper ──────────────────────────────────────────

/**
 * Merge partial user overrides onto a base AgentDefinition.
 * Returns a new object — never mutates the base.
 */
export function resolveAgent(
  base: AgentDefinition,
  overrides?: Partial<
    Pick<AgentDefinition, 'model' | 'provider' | 'systemPrompt' | 'permissionMode'>
  >,
): AgentDefinition {
  if (!overrides) return base;
  return {
    ...base,
    ...(overrides.model != null ? { model: overrides.model } : {}),
    ...(overrides.provider != null ? { provider: overrides.provider } : {}),
    ...(overrides.permissionMode != null ? { permissionMode: overrides.permissionMode } : {}),
    ...(overrides.systemPrompt != null ? { systemPrompt: overrides.systemPrompt } : {}),
  };
}

// ── Pipeline agent prompts ──────────────────────────────────

function reviewerPrompt(ctx: Record<string, string>): string {
  const shaRef = ctx.commitSha || 'HEAD';

  const diffInstruction = `Run this command to get the diff:
\`git diff ${shaRef}~1..${shaRef}\`

If that fails (first commit), run: \`git show ${shaRef}\``;

  const jsonFormat = `You MUST respond with a JSON block at the end of your message in exactly this format:
\`\`\`json
{
  "verdict": "pass" | "fail",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "category": "bug" | "security" | "performance" | "logic" | "style",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "What is wrong",
      "suggestion": "How to fix it"
    }
  ]
}
\`\`\`

If there are no significant issues, return verdict "pass" with an empty findings array.`;

  return `You are a code reviewer. Analyze the changes in the latest commit.

${diffInstruction}

Review the diff for:
- Bugs and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- Code that contradicts existing patterns

${jsonFormat}
Only flag real problems — do not flag style preferences or nitpicks unless they indicate bugs.`;
}

function correctorPrompt(): string {
  return `You are a code corrector.

Instructions:
1. Read each finding carefully
2. Fix the issues in the source files
3. Run the build to verify your changes compile: \`bun run build\` or equivalent
4. Run the tests to verify nothing is broken: \`bun run test\` or equivalent
5. Do NOT create a git commit — just fix the files

Fix only what the reviewer flagged. Do not make unrelated changes.`;
}

function precommitFixerPrompt(): string {
  return `Fix the issues reported by the pre-commit hook. Only modify the files that have errors.
After fixing, stage your changes with \`git add\`.
Do NOT create a commit.`;
}

function testFixerPrompt(): string {
  return `Analyze the test failures and fix the underlying code. Focus on:
- Fix the source code that causes the test failures
- Only modify tests if the tests themselves have bugs
- Do not delete or skip failing tests

After fixing, run the tests again to verify they pass.
Do NOT create a git commit — just fix the files and stage your changes with \`git add\`.`;
}

// ── Built-in agent registry ─────────────────────────────────

export const BUILTIN_AGENTS = {
  // Pipeline agents
  reviewer: {
    name: 'reviewer',
    label: 'Code Reviewer',
    systemPrompt: reviewerPrompt,
    model: 'sonnet' as AgentModel,
    provider: 'claude' as AgentProvider,
    permissionMode: 'plan' as PermissionMode,
    // Hard-deny mutating tools at the SDK level so the reviewer can't
    // edit files even if the system prompt is overridden or ignored.
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
  },
  corrector: {
    name: 'corrector',
    label: 'Code Corrector',
    systemPrompt: correctorPrompt(),
    model: 'sonnet' as AgentModel,
    provider: 'claude' as AgentProvider,
    permissionMode: 'autoEdit' as PermissionMode,
  },
  precommitFixer: {
    name: 'precommit-fixer',
    label: 'Pre-commit Fixer',
    systemPrompt: precommitFixerPrompt(),
    model: 'sonnet' as AgentModel,
    provider: 'claude' as AgentProvider,
    permissionMode: 'autoEdit' as PermissionMode,
  },
  testFixer: {
    name: 'test-fixer',
    label: 'Test Fixer',
    systemPrompt: testFixerPrompt(),
    model: 'sonnet' as AgentModel,
    provider: 'claude' as AgentProvider,
    permissionMode: 'autoEdit' as PermissionMode,
  },
} as const satisfies Record<string, AgentDefinition>;

// ── Lookup by `.name` (matches what YAML pipelines reference) ──
//
// `BUILTIN_AGENTS` is keyed by camelCase TypeScript identifiers (e.g.
// `precommitFixer`), but YAML pipelines reference agents by their kebab-case
// `name` field (e.g. `precommit-fixer`). This helper bridges the two and
// is the canonical resolver passed to `loadPipelines({ resolveAgent })`.

const BUILTIN_AGENTS_BY_NAME: Record<string, AgentDefinition> = Object.fromEntries(
  Object.values(BUILTIN_AGENTS).map((def) => [def.name, def]),
);

export function resolveBuiltinAgentByName(name: string): AgentDefinition | undefined {
  return BUILTIN_AGENTS_BY_NAME[name];
}
