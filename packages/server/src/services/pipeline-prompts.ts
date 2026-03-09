/**
 * @domain subdomain: Pipeline
 * @domain subdomain-type: core
 * @domain type: prompts
 * @domain layer: application
 *
 * All prompt templates used by server-side pipeline and git operations.
 */

// ── Pipeline review/fix prompts ─────────────────────────────

export function buildReviewerPrompt(commitSha: string | undefined): string {
  const shaRef = commitSha ? commitSha : 'HEAD';
  return `You are a code reviewer. Analyze the changes in the latest commit.

Run this command to get the diff:
\`git diff ${shaRef}~1..${shaRef}\`

If that fails (first commit), run: \`git show ${shaRef}\`

Review the diff for:
- Bugs and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- Code that contradicts existing patterns

You MUST respond with a JSON block at the end of your message in exactly this format:
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

If there are no significant issues, return verdict "pass" with an empty findings array.
Only flag real problems — do not flag style preferences or nitpicks unless they indicate bugs.`;
}

export function buildCorrectorPrompt(findings: string): string {
  return `You are a code corrector. The reviewer found the following issues that need to be fixed:

${findings}

Instructions:
1. Read each finding carefully
2. Fix the issues in the source files
3. Run the build to verify your changes compile: \`bun run build\` or equivalent
4. Run the tests to verify nothing is broken: \`bun run test\` or equivalent
5. Do NOT create a git commit — just fix the files

Fix only what the reviewer flagged. Do not make unrelated changes.`;
}

// ── Pre-commit fixer prompt ─────────────────────────────────

export function buildPrecommitFixerPrompt(
  hookName: string,
  errorOutput: string,
  stagedFiles: string[],
): string {
  return `A pre-commit hook "${hookName}" failed with the following error:

\`\`\`
${errorOutput}
\`\`\`

The staged files are:
${stagedFiles.map((f) => `- ${f}`).join('\n')}

Fix the issues reported by the hook. Only modify the files that have errors.
After fixing, stage your changes with \`git add\`.
Do NOT create a commit.`;
}

// ── Commit message generation prompts ───────────────────────

export const COMMIT_MESSAGE_SYSTEM_PROMPT =
  'You are a commit message generator. Output only the requested format, nothing else.';

export function buildCommitMessagePrompt(diffSummary: string): string {
  return `You are a commit message generator. Based on the following git diff, generate a commit title and a commit body.

Rules:
- The title must use conventional commits style (e.g. "feat: ...", "fix: ...", "refactor: ..."), be concise (max 72 chars), and summarize the change.
- The body must be a short paragraph (2-4 sentences) explaining what changed and why.
- Output EXACTLY in this format, with the separator line:
TITLE: <the title>
BODY: <the body>

No quotes, no markdown, no extra explanation.

${diffSummary}`;
}
