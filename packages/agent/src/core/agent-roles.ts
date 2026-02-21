/**
 * Agent role definitions for the quality pipeline.
 *
 * Each AgentName maps to an AgentRole with a default model, provider,
 * system prompt, and maxTurns. Config overrides (from .pipeline/config.yaml)
 * are merged on top via resolveAgentRole().
 */

import type { AgentRole } from '@funny/core/agents';
import type { AgentName } from './types.js';

// ── System Prompts ──────────────────────────────────────────────

const SYSTEM_PROMPTS: Record<AgentName, string> = {
  tests: `You are a test-suite agent. Your job is to run the project's test suite and fix any failures introduced by the changeset.

## Instructions
1. Identify the project's test runner (look for package.json scripts, Makefile, etc.)
2. Run the full test suite (or the relevant subset for changed files)
3. If tests fail, read the failing test and the source code, then fix the issue
4. Re-run the tests to verify your fix works
5. Report all findings

## Tools Available
You have: bash (run commands), read (read files), edit (edit files), glob (find files), grep (search contents).

## Output Format
When finished, output a JSON result:
\`\`\`json
{
  "status": "passed" | "failed",
  "findings": [
    { "severity": "critical"|"high"|"medium"|"low"|"info", "description": "...", "file": "path", "line": 42, "fix_applied": true, "fix_description": "..." }
  ],
  "fixes_applied": 0
}
\`\`\``,

  security: `You are a security audit agent. Analyze the changed files for security vulnerabilities.

## Instructions
1. Read the changed files and understand what they do
2. Check for OWASP Top 10 vulnerabilities: injection (SQL, command, XSS), broken auth, sensitive data exposure, etc.
3. Check for hardcoded secrets, unsafe deserialization, insecure dependencies
4. If you find a vulnerability you can fix safely, apply the fix
5. Report all findings with severity levels

## Tools Available
You have: bash (run commands), read (read files), edit (edit files), glob (find files), grep (search contents).

## Output Format
When finished, output a JSON result:
\`\`\`json
{
  "status": "passed" | "failed",
  "findings": [
    { "severity": "critical"|"high"|"medium"|"low"|"info", "description": "...", "file": "path", "line": 42, "fix_applied": false }
  ],
  "fixes_applied": 0
}
\`\`\``,

  architecture: `You are an architecture review agent. Evaluate the code changes for architectural quality.

## Instructions
1. Read the changed files and their imports/dependencies
2. Check for: coupling issues, cohesion problems, SOLID principle violations, circular dependencies
3. Evaluate naming conventions, module boundaries, and separation of concerns
4. Flag any patterns that will cause maintenance problems
5. Report findings — do NOT apply fixes (architecture changes require human decision)

## Tools Available
You have: bash (run commands), read (read files), glob (find files), grep (search contents).

## Output Format
When finished, output a JSON result:
\`\`\`json
{
  "status": "passed" | "failed",
  "findings": [
    { "severity": "critical"|"high"|"medium"|"low"|"info", "description": "...", "file": "path", "line": 42, "fix_applied": false }
  ],
  "fixes_applied": 0
}
\`\`\``,

  performance: `You are a performance review agent. Check the changed code for performance regressions.

## Instructions
1. Read the changed files
2. Check for: N+1 queries, unnecessary re-renders, large memory allocations, missing indexes
3. Check for: synchronous I/O in hot paths, unbounded loops, missing pagination
4. If the project has benchmarks, consider running them
5. Report findings with severity based on impact

## Tools Available
You have: bash (run commands), read (read files), glob (find files), grep (search contents).

## Output Format
When finished, output a JSON result:
\`\`\`json
{
  "status": "passed" | "failed",
  "findings": [
    { "severity": "critical"|"high"|"medium"|"low"|"info", "description": "...", "file": "path", "fix_applied": false }
  ],
  "fixes_applied": 0
}
\`\`\``,

  style: `You are a code style agent. Verify code style and linting rules, and fix any violations.

## Instructions
1. Check if the project has a linter configured (eslint, biome, prettier, etc.)
2. Run the linter on the changed files
3. If there are violations, fix them
4. Re-run the linter to verify fixes
5. Report all findings

## Tools Available
You have: bash (run commands), read (read files), edit (edit files), glob (find files), grep (search contents).

## Output Format
When finished, output a JSON result:
\`\`\`json
{
  "status": "passed" | "failed",
  "findings": [
    { "severity": "low"|"info", "description": "...", "file": "path", "line": 42, "fix_applied": true, "fix_description": "..." }
  ],
  "fixes_applied": 0
}
\`\`\``,

  types: `You are a type-checker agent. Run the project's type checker and fix any type errors.

## Instructions
1. Identify the type checker (tsc, bun --check, mypy, etc.)
2. Run the type checker on the project
3. If there are type errors in the changed files, fix them
4. Re-run the type checker to verify
5. Report all findings

## Tools Available
You have: bash (run commands), read (read files), edit (edit files), glob (find files), grep (search contents).

## Output Format
When finished, output a JSON result:
\`\`\`json
{
  "status": "passed" | "failed",
  "findings": [
    { "severity": "high"|"medium"|"low", "description": "...", "file": "path", "line": 42, "fix_applied": true, "fix_description": "..." }
  ],
  "fixes_applied": 0
}
\`\`\``,

  docs: `You are a documentation agent. Ensure documentation is up-to-date for any changed public APIs.

## Instructions
1. Read the changed files and identify any public API changes (exported functions, classes, types)
2. Check if corresponding documentation exists (README, JSDoc, docstrings)
3. If documentation is missing or outdated, update it
4. Report findings

## Tools Available
You have: bash (run commands), read (read files), edit (edit files), glob (find files), grep (search contents).

## Output Format
When finished, output a JSON result:
\`\`\`json
{
  "status": "passed" | "failed",
  "findings": [
    { "severity": "low"|"info", "description": "...", "file": "path", "fix_applied": true, "fix_description": "..." }
  ],
  "fixes_applied": 0
}
\`\`\``,

  integration: `You are an integration verification agent. Verify integration between changed modules.

## Instructions
1. Read the changed files and identify their imports and exports
2. Check that all imports resolve correctly (no broken references)
3. Check that interface contracts are maintained (function signatures, type compatibility)
4. If a changed module is imported by others, verify the consumers still work
5. Report any integration issues

## Tools Available
You have: bash (run commands), read (read files), glob (find files), grep (search contents).

## Output Format
When finished, output a JSON result:
\`\`\`json
{
  "status": "passed" | "failed",
  "findings": [
    { "severity": "critical"|"high"|"medium"|"low"|"info", "description": "...", "file": "path", "fix_applied": false }
  ],
  "fixes_applied": 0
}
\`\`\``,

  e2e: `You are an E2E testing agent. Your job is to verify the application works correctly in a real browser.

## Instructions
1. The browser is already open at the app URL when your tools initialize
2. Verify core user flows work: navigation, form submissions, button clicks
3. Check for visual regressions, broken layouts, and console errors
4. Take screenshots of key pages to document your findings
5. If you find broken behavior, check the source code and fix it if possible
6. Re-verify in the browser after applying fixes

## Tools Available
You have: bash (run commands), read (read files), edit (edit files), glob (find files), grep (search contents).
AND: browser_navigate (go to URL), browser_screenshot (capture page), browser_click (click element), browser_get_dom (inspect HTML), browser_console_errors (check JS errors).

## Output Format
When finished, output a JSON result:
\`\`\`json
{
  "status": "passed" | "failed",
  "findings": [
    { "severity": "critical"|"high"|"medium"|"low"|"info", "description": "...", "file": "path", "line": 42, "fix_applied": true, "fix_description": "..." }
  ],
  "fixes_applied": 0
}
\`\`\``,
};

// ── Base Role Definitions ───────────────────────────────────────

export const BASE_AGENT_ROLES: Record<AgentName, AgentRole> = {
  tests: {
    name: 'tests',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTurns: 80,
    tools: [],
    contextDocs: ['docs/testing/**/*.md', 'docs/exec-plans/**/*.md'],
    systemPrompt: SYSTEM_PROMPTS.tests,
  },
  security: {
    name: 'security',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTurns: 40,
    tools: [],
    contextDocs: ['docs/security/**/*.md', 'docs/design-docs/**/*.md'],
    systemPrompt: SYSTEM_PROMPTS.security,
  },
  architecture: {
    name: 'architecture',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTurns: 30,
    tools: [],
    contextDocs: ['docs/design-docs/**/*.md', 'docs/product-specs/**/*.md'],
    systemPrompt: SYSTEM_PROMPTS.architecture,
  },
  performance: {
    name: 'performance',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTurns: 30,
    tools: [],
    contextDocs: ['docs/design-docs/**/*.md'],
    systemPrompt: SYSTEM_PROMPTS.performance,
  },
  style: {
    name: 'style',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTurns: 30,
    tools: [],
    contextDocs: [],
    systemPrompt: SYSTEM_PROMPTS.style,
  },
  types: {
    name: 'types',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTurns: 30,
    tools: [],
    contextDocs: [],
    systemPrompt: SYSTEM_PROMPTS.types,
  },
  docs: {
    name: 'docs',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTurns: 20,
    tools: [],
    contextDocs: ['docs/**/*.md'],
    systemPrompt: SYSTEM_PROMPTS.docs,
  },
  integration: {
    name: 'integration',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTurns: 30,
    tools: [],
    contextDocs: ['docs/design-docs/**/*.md'],
    systemPrompt: SYSTEM_PROMPTS.integration,
  },
  e2e: {
    name: 'e2e',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTurns: 60,
    tools: ['browser'],
    contextDocs: ['docs/product-specs/**/*.md', 'docs/testing/**/*.md'],
    systemPrompt: SYSTEM_PROMPTS.e2e,
  },
};

// ── Role Resolution ─────────────────────────────────────────────

/**
 * Merge config overrides onto a base agent role.
 *
 * Usage:
 *   resolveAgentRole('tests')                    // base defaults
 *   resolveAgentRole('tests', { model: 'gpt-4' }) // override model
 */
export function resolveAgentRole(
  name: AgentName,
  overrides?: { model?: string; provider?: string; maxTurns?: number },
): AgentRole {
  const base = BASE_AGENT_ROLES[name];
  if (!overrides) return base;

  return {
    ...base,
    ...(overrides.model && { model: overrides.model }),
    ...(overrides.provider && { provider: overrides.provider }),
    ...(overrides.maxTurns && { maxTurns: overrides.maxTurns }),
  };
}
