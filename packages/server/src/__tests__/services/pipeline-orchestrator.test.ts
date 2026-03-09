/**
 * Pipeline orchestrator tests — pure functions only.
 *
 * These test parseReviewVerdict, isHookAutoFixable, and buildPrecommitFixerPrompt
 * without any DB or agent dependencies.
 *
 * We mock all side-effecting imports at the top so vitest can load the module.
 */
import { describe, test, expect, vi } from 'vitest';

// Mock bun:sqlite and all heavy imports so the module can load in vitest
vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn() })) })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
  },
}));
vi.mock('../../services/agent-runner.js', () => ({
  startAgent: vi.fn(),
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../services/thread-service.js', () => ({
  createAndStartThread: vi.fn(),
}));
vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { emitToUser: vi.fn(), broadcast: vi.fn() },
}));
vi.mock('../../services/thread-manager.js', () => ({
  getThread: vi.fn(),
  getThreadWithMessages: vi.fn(),
  updateThread: vi.fn(),
}));
vi.mock('../../services/project-manager.js', () => ({
  getProject: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  parseReviewVerdict,
  isHookAutoFixable,
  buildPrecommitFixerPrompt,
} from '../../services/pipeline-orchestrator.js';

// ── parseReviewVerdict ──────────────────────────────────────

describe('parseReviewVerdict', () => {
  test('parses verdict from ```json code block', () => {
    const content = `I reviewed the code and found no issues.

\`\`\`json
{
  "verdict": "pass",
  "findings": []
}
\`\`\``;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual([]);
  });

  test('parses fail verdict with findings from code block', () => {
    const content = `Found some issues:

\`\`\`json
{
  "verdict": "fail",
  "findings": [
    {
      "severity": "high",
      "category": "bug",
      "file": "src/index.ts",
      "line": 42,
      "description": "Null pointer dereference",
      "suggestion": "Add null check"
    }
  ]
}
\`\`\``;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('fail');
    expect(result.findings).toEqual([
      {
        severity: 'high',
        category: 'bug',
        file: 'src/index.ts',
        line: 42,
        description: 'Null pointer dereference',
        suggestion: 'Add null check',
      },
    ]);
  });

  test('parses raw JSON object without code fence', () => {
    const content = `Here is my review: {"verdict": "pass", "findings": []}`;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual([]);
  });

  test('parses raw JSON with fail verdict', () => {
    const content = `After review, {"verdict": "fail", "findings": [{"severity": "critical", "description": "SQL injection"}]}`;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('fail');
    expect(result.findings).toHaveLength(1);
  });

  test('uses heuristic for "verdict": "pass" keyword', () => {
    const content = `The code looks good. "verdict": "pass" — no issues found.`;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual([]);
  });

  test('uses heuristic for "verdict: pass" keyword', () => {
    const content = `verdict: pass. All checks look fine.`;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('pass');
  });

  test('uses heuristic for "all checks pass" keyword', () => {
    const content = `I've reviewed everything and all checks pass.`;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('pass');
  });

  test('defaults to fail when content is unparseable', () => {
    const content = `I looked at the code but couldn't figure out the format.`;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('fail');
    expect(result.findings).toBe(content);
  });

  test('defaults to fail for empty content', () => {
    const result = parseReviewVerdict('');
    expect(result.verdict).toBe('fail');
  });

  test('handles malformed JSON in code block — falls through to heuristic', () => {
    // When JSON parsing fails, the heuristic finds "verdict": "pass" in the text
    const content = `\`\`\`json
{
  "verdict": "pass",
  "findings": [BROKEN
}
\`\`\``;
    const result = parseReviewVerdict(content);
    // Heuristic picks up the "verdict": "pass" text even though JSON is malformed
    expect(result.verdict).toBe('pass');
  });

  test('defaults to fail for completely unparseable malformed JSON', () => {
    const content = `\`\`\`json
{ broken garbage here }
\`\`\``;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('fail');
  });

  test('treats unknown verdict values as fail', () => {
    const content = `\`\`\`json
{
  "verdict": "maybe",
  "findings": []
}
\`\`\``;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('fail');
  });

  test('defaults findings to empty array when missing', () => {
    const content = `\`\`\`json
{
  "verdict": "pass"
}
\`\`\``;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual([]);
  });

  test('handles multiple code blocks — uses first json block', () => {
    const content = `Some text

\`\`\`json
{
  "verdict": "pass",
  "findings": []
}
\`\`\`

\`\`\`json
{
  "verdict": "fail",
  "findings": [{"severity": "high"}]
}
\`\`\``;
    const result = parseReviewVerdict(content);
    expect(result.verdict).toBe('pass');
  });
});

// ── isHookAutoFixable ───────────────────────────────────────

describe('isHookAutoFixable', () => {
  test('returns true for oxlint (general hook)', () => {
    expect(isHookAutoFixable('oxlint')).toBe(true);
  });

  test('returns true for Lint (oxlint)', () => {
    expect(isHookAutoFixable('Lint (oxlint)')).toBe(true);
  });

  test('returns true for Conflict markers', () => {
    expect(isHookAutoFixable('Conflict markers')).toBe(true);
  });

  test('returns false for unknown hooks (opt-in allowlist model)', () => {
    expect(isHookAutoFixable('eslint')).toBe(false);
    expect(isHookAutoFixable('prettier')).toBe(false);
    expect(isHookAutoFixable('myCustomHook')).toBe(false);
    expect(isHookAutoFixable('Command 1')).toBe(false);
    expect(isHookAutoFixable('JSON válido')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isHookAutoFixable('')).toBe(false);
  });

  test('returns false for secretlint (security — blocked)', () => {
    expect(isHookAutoFixable('secretlint')).toBe(false);
  });

  test('returns false for secrets-related hooks (security — blocked)', () => {
    expect(isHookAutoFixable('Sin secrets')).toBe(false);
    expect(isHookAutoFixable('Secrets check')).toBe(false);
  });

  test('is case-insensitive for blocked hooks', () => {
    expect(isHookAutoFixable('SECRETLINT')).toBe(false);
    expect(isHookAutoFixable('SIN SECRETS')).toBe(false);
  });
});

// ── buildPrecommitFixerPrompt ───────────────────────────────

describe('buildPrecommitFixerPrompt', () => {
  test('includes hook name in prompt', () => {
    const prompt = buildPrecommitFixerPrompt('oxlint', 'error: no-unused', ['src/app.ts']);
    expect(prompt).toContain('oxlint');
  });

  test('includes error output in prompt', () => {
    const errorOutput = 'error: no-unused-vars at line 42';
    const prompt = buildPrecommitFixerPrompt('oxlint', errorOutput, ['src/app.ts']);
    expect(prompt).toContain(errorOutput);
  });

  test('includes staged files in prompt', () => {
    const files = ['src/index.ts', 'src/utils.ts', 'README.md'];
    const prompt = buildPrecommitFixerPrompt('oxlint', 'error', files);
    for (const file of files) {
      expect(prompt).toContain(file);
    }
  });

  test('instructs agent not to commit', () => {
    const prompt = buildPrecommitFixerPrompt('oxlint', 'error', ['file.ts']);
    expect(prompt.toLowerCase()).toContain('do not create a commit');
  });

  test('instructs agent to stage changes', () => {
    const prompt = buildPrecommitFixerPrompt('oxlint', 'error', ['file.ts']);
    expect(prompt).toContain('git add');
  });

  test('handles empty staged files list', () => {
    const prompt = buildPrecommitFixerPrompt('oxlint', 'error', []);
    expect(prompt).toContain('oxlint');
    expect(prompt).toBeDefined();
  });
});
