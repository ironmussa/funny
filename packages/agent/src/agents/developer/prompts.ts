/**
 * Prompts for the OrchestratorAgent — planning and implementing issues.
 */

import type { ImplementationPlan } from '../../core/session.js';
import type { IssueDetail } from '../../trackers/tracker.js';

export function buildPlanningPrompt(issue: IssueDetail, projectPath: string): string {
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

export function buildImplementingPrompt(issue: IssueDetail, plan: ImplementationPlan): string {
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
