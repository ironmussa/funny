/**
 * PRReviewer — core ReviewBot flow.
 *
 * Single-pass V1: fetch PR → analyze with LLM → post review.
 * No tools needed — the agent only reads the diff (passed as context).
 */

import { getPRInfo, getPRDiff, postPRReview } from '@funny/core/git';
import type { PRInfo, ReviewEvent } from '@funny/core/git';
import type { CodeReviewFinding, CodeReviewResult, ReviewFindingSeverity, ReviewFindingCategory } from '@funny/shared';
import { buildReviewSystemPrompt, buildReviewUserPrompt } from './prompts.js';
import { formatReviewBody, decideReviewEvent } from './formatter.js';
import type { ReviewOptions, ParsedReviewOutput } from './types.js';

// ── Defaults ───────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const DEFAULT_ACP_BASE_URL = 'http://localhost:4010';

// ── ACP API call ────────────────────────────────────────────────

async function callACP(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  acpBaseUrl: string,
): Promise<string> {
  const url = `${acpBaseUrl}/v1/runs`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      system_prompt: systemPrompt,
      prompt: userPrompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'Unknown error');
    throw new Error(`ACP API error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json() as {
    result?: { text?: string };
  };

  return data.result?.text ?? '';
}

// ── Parser ─────────────────────────────────────────────────────

const VALID_SEVERITIES = new Set<ReviewFindingSeverity>([
  'critical', 'high', 'medium', 'low', 'suggestion',
]);
const VALID_CATEGORIES = new Set<ReviewFindingCategory>([
  'bug', 'security', 'performance', 'style', 'logic', 'maintainability',
]);

function parseReviewOutput(text: string): ParsedReviewOutput {
  // Extract JSON from markdown code blocks or raw JSON
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    ?? text.match(/(\{[\s\S]*"summary"[\s\S]*\})/);

  if (!jsonMatch) {
    return { summary: 'Could not parse review output.', findings: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);

    const summary = typeof parsed.summary === 'string'
      ? parsed.summary
      : 'Review completed.';

    const findings = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter((f: any) => f && typeof f.description === 'string' && typeof f.file === 'string')
          .map((f: any) => ({
            severity: VALID_SEVERITIES.has(f.severity) ? f.severity : 'low',
            category: VALID_CATEGORIES.has(f.category) ? f.category : 'logic',
            file: f.file,
            line: typeof f.line === 'number' ? f.line : undefined,
            description: f.description,
            suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
          }))
      : [];

    return { summary, findings };
  } catch {
    return { summary: 'Could not parse review output.', findings: [] };
  }
}

// ── Main reviewer ──────────────────────────────────────────────

export class PRReviewer {
  /**
   * Run a full code review on a PR.
   *
   * @param cwd - Working directory (must be inside a git repo with `gh` configured)
   * @param prNumber - The PR number to review
   * @param options - Model, provider, and other options
   * @returns CodeReviewResult with findings and the review status
   */
  async review(
    cwd: string,
    prNumber: number,
    options: ReviewOptions = {},
  ): Promise<CodeReviewResult> {
    const model = options.model ?? DEFAULT_MODEL;
    const shouldPost = options.post !== false;
    const acpBaseUrl = options.acpBaseUrl ?? process.env.ACP_BASE_URL ?? DEFAULT_ACP_BASE_URL;
    const startTime = Date.now();

    // Step 1: Fetch PR info and diff in parallel
    const [infoResult, diffResult] = await Promise.all([
      getPRInfo(cwd, prNumber),
      getPRDiff(cwd, prNumber),
    ]);

    const prInfo = infoResult.match(
      (val) => val,
      (err) => { throw new Error(`Failed to fetch PR info: ${err.message}`); },
    );

    const diff = diffResult.match(
      (val) => val,
      (err) => { throw new Error(`Failed to fetch PR diff: ${err.message}`); },
    );

    if (!diff.trim()) {
      return {
        prNumber,
        status: 'approved',
        summary: 'Empty diff — nothing to review.',
        findings: [],
        duration_ms: Date.now() - startTime,
        model,
      };
    }

    // Step 2: Call LLM to analyze the diff
    const systemPrompt = buildReviewSystemPrompt();
    const userPrompt = buildReviewUserPrompt(prInfo.title, prInfo.body, diff);

    const llmOutput = await callACP(systemPrompt, userPrompt, model, acpBaseUrl);

    // Step 3: Parse LLM output into structured findings
    const parsed = parseReviewOutput(llmOutput);
    const findings: CodeReviewFinding[] = parsed.findings as CodeReviewFinding[];

    // Step 4: Post review to GitHub
    const reviewEvent: ReviewEvent = decideReviewEvent(findings);
    const reviewBody = formatReviewBody(parsed.summary, findings);

    if (shouldPost) {
      const postResult = await postPRReview(cwd, prNumber, reviewBody, reviewEvent);
      postResult.match(
        () => {},
        (err) => { throw new Error(`Failed to post review: ${err.message}`); },
      );
    }

    const statusMap: Record<ReviewEvent, CodeReviewResult['status']> = {
      APPROVE: 'approved',
      REQUEST_CHANGES: 'changes_requested',
      COMMENT: 'commented',
    };

    return {
      prNumber,
      status: statusMap[reviewEvent],
      summary: parsed.summary,
      findings,
      duration_ms: Date.now() - startTime,
      model,
    };
  }
}
