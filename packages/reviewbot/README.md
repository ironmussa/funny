# @funny/reviewbot

Automated code review for GitHub pull requests powered by Claude. Single-pass architecture: fetches the PR diff, analyzes it with the Anthropic API, and posts structured findings back as a GitHub review.

## How It Works

```
review(cwd, prNumber, options?)
        │
        ▼
┌──────────────────────────────┐
│ 1. Fetch PR info & diff      │  gh pr view / gh pr diff (parallel)
└──────────────────────────────┘
        │
        ▼
┌──────────────────────────────┐
│ 2. Call Anthropic API        │  POST /v1/messages
│    System: review rules      │  Model: claude-sonnet-4-5 (default)
│    User: title + body + diff │  Max tokens: 8192
└──────────────────────────────┘
        │
        ▼
┌──────────────────────────────┐
│ 3. Parse LLM response        │  Extract JSON → validate findings
└──────────────────────────────┘
        │
        ▼
┌──────────────────────────────┐
│ 4. Post review to GitHub     │  gh pr review (APPROVE / REQUEST_CHANGES / COMMENT)
└──────────────────────────────┘
        │
        ▼
    CodeReviewResult
```

## Usage

```typescript
import { PRReviewer } from '@funny/reviewbot';

const reviewer = new PRReviewer();

const result = await reviewer.review('/path/to/repo', 42, {
  model: 'claude-sonnet-4-5-20250929', // default
  post: true,                           // post review to GitHub (default)
});

console.log(result);
// {
//   prNumber: 42,
//   status: 'changes_requested',
//   summary: 'Found a potential SQL injection in...',
//   findings: [ ... ],
//   duration_ms: 3200,
//   model: 'claude-sonnet-4-5-20250929'
// }
```

## Prerequisites

- `ANTHROPIC_API_KEY` environment variable set
- `gh` CLI installed and authenticated (used for fetching PR data and posting reviews)
- Working directory must be inside a git repo

## Options

| Option     | Type      | Default                       | Description                          |
|------------|-----------|-------------------------------|--------------------------------------|
| `model`    | `string`  | `claude-sonnet-4-5-20250929`  | Anthropic model ID                   |
| `provider` | `string`  | `anthropic`                   | LLM provider                         |
| `maxTurns` | `number`  | `50`                          | Max agent turns (reserved for V2)    |
| `post`     | `boolean` | `true`                        | Whether to post the review to GitHub |

## What It Reviews

Ordered by priority:

1. **Bugs** - Logic errors, null/undefined access, race conditions, resource leaks
2. **Security** - Injection (SQL, command, XSS), auth bypasses, secrets exposure
3. **Performance** - N+1 queries, unbounded loops, memory leaks, sync I/O in hot paths
4. **Logic** - Incorrect conditions, missing edge cases, wrong error handling
5. **Maintainability** - Only when it causes real problems (circular deps, untestable code)

It deliberately **skips**: style/formatting, missing comments, cosmetic suggestions, and hypothetical issues.

## Severity Levels

| Severity     | Meaning                                              | GitHub Action      |
|--------------|------------------------------------------------------|--------------------|
| `critical`   | Data loss, security breach, or crash in production   | REQUEST_CHANGES    |
| `high`       | Incorrect behavior for users                         | REQUEST_CHANGES    |
| `medium`     | Could cause issues under certain conditions          | COMMENT            |
| `low`        | Minor issue, unlikely to cause problems              | COMMENT            |
| `suggestion` | Improvement idea, not a bug                          | COMMENT            |

If no findings are found, the PR is auto-approved.

## Output Format

The LLM returns structured JSON that gets parsed into `CodeReviewFinding` objects:

```typescript
interface CodeReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'suggestion';
  category: 'bug' | 'security' | 'performance' | 'style' | 'logic' | 'maintainability';
  file: string;       // e.g. "src/db.ts"
  line?: number;      // e.g. 42
  description: string;
  suggestion?: string;
}
```

Posted to GitHub as formatted markdown:

```markdown
## ReviewBot

Found a potential SQL injection vulnerability in the query builder.

**1 finding:**

🔴 **critical** (security) — `src/db.ts:42`
  Direct user input passed to SQL query without parameterization.
  > **Suggestion:** Use parameterized queries with ? placeholders.

---
*Generated by funny ReviewBot*
```

## File Structure

```
packages/reviewbot/
├── package.json        Dependencies and config
└── src/
    ├── index.ts        Public exports
    ├── types.ts        ReviewOptions, ParsedFinding, ParsedReviewOutput
    ├── reviewer.ts     PRReviewer class — orchestrates the full flow
    ├── prompts.ts      System and user prompt builders for the LLM
    └── formatter.ts    GitHub markdown formatting + review event logic
```

## Dependencies

- **@funny/core** - Git/GitHub operations (`getPRInfo`, `getPRDiff`, `postPRReview`)
- **@funny/shared** - Shared types (`CodeReviewResult`, `CodeReviewFinding`)

## Exports

```typescript
// Main class
export { PRReviewer } from './reviewer.js';

// Prompt builders (useful for customization)
export { buildReviewSystemPrompt, buildReviewUserPrompt } from './prompts.js';

// Formatter utilities
export { formatReviewBody, decideReviewEvent } from './formatter.js';

// Types
export type { ReviewOptions, ParsedReviewOutput, ParsedFinding } from './types.js';
```
