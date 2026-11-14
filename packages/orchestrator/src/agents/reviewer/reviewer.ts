/**
 * PRReviewer — core ReviewBot flow.
 *
 * Single-pass V1: fetch PR → analyze with LLM → post review.
 * Uses the agent layer (IAgentProcess) from @funny/core for LLM calls,
 * supporting Claude, Codex, Gemini, or any registered provider.
 */

import {
  defaultProcessFactory,
  type IAgentProcess,
  type IAgentProcessFactory,
  type CLIAssistantMessage,
  type CLIResultMessage,
} from '@funny/core/agents';
import { getPRInfo, getPRDiff, postPRReview } from '@funny/core/git';
import type { ReviewEvent } from '@funny/core/git';
import type {
  CodeReviewFinding,
  CodeReviewResult,
  ReviewFindingSeverity,
  ReviewFindingCategory,
} from '@funny/shared';

import { formatReviewBody, decideReviewEvent } from './formatter.js';
import { buildReviewSystemPrompt, buildReviewUserPrompt } from './prompts.js';
import type { ReviewOptions, PRReviewerConfig, ParsedReviewOutput } from './types.js';

// ── Defaults ───────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const DEFAULT_PROVIDER = 'claude';

// ── Parser ─────────────────────────────────────────────────────

const VALID_SEVERITIES = new Set<ReviewFindingSeverity>([
  'critical',
  'high',
  'medium',
  'low',
  'suggestion',
]);
const VALID_CATEGORIES = new Set<ReviewFindingCategory>([
  'bug',
  'security',
  'performance',
  'style',
  'logic',
  'maintainability',
]);

function parseReviewOutput(text: string): ParsedReviewOutput {
  // Extract JSON from markdown code blocks or raw JSON
  const jsonMatch =
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*"summary"[\s\S]*\})/);

  if (!jsonMatch) {
    return { summary: 'Could not parse review output.', findings: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);

    const summary = typeof parsed.summary === 'string' ? parsed.summary : 'Review completed.';

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

// ── Agent-based LLM call ────────────────────────────────────────

/**
 * Run a single-pass LLM call using the agent process layer.
 * Creates an IAgentProcess, sends the review prompt, and collects the result.
 */
function callAgent(
  factory: IAgentProcessFactory,
  systemPrompt: string,
  userPrompt: string,
  model: string,
  provider: string,
  cwd: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

    const agentProcess: IAgentProcess = factory.create({
      prompt: fullPrompt,
      cwd,
      model,
      provider: provider as any,
      maxTurns: 1,
      permissionMode: 'plan', // read-only, no tool execution needed
    });

    let resultText = '';
    let lastAssistantText = '';
    let errorOccurred: Error | null = null;

    agentProcess.on('message', (msg) => {
      if (msg.type === 'assistant') {
        const assistantMsg = msg as CLIAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            lastAssistantText += block.text;
          }
        }
      }
      if (msg.type === 'result') {
        const resultMsg = msg as CLIResultMessage;
        resultText = resultMsg.result ?? lastAssistantText;
      }
    });

    agentProcess.on('error', (err) => {
      errorOccurred = err;
    });

    agentProcess.on('exit', () => {
      if (errorOccurred) {
        reject(errorOccurred);
      } else {
        resolve(resultText || lastAssistantText);
      }
    });

    agentProcess.start();
  });
}

// ── Main reviewer ──────────────────────────────────────────────

export class PRReviewer {
  private processFactory: IAgentProcessFactory;

  constructor(config: PRReviewerConfig = {}) {
    this.processFactory = config.processFactory ?? defaultProcessFactory;
  }

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
    const provider = options.provider ?? DEFAULT_PROVIDER;
    const shouldPost = options.post !== false;
    const startTime = Date.now();

    // Step 1: Fetch PR info and diff in parallel
    const [infoResult, diffResult] = await Promise.all([
      getPRInfo(cwd, prNumber),
      getPRDiff(cwd, prNumber),
    ]);

    const prInfo = infoResult.match(
      (val) => val,
      (err) => {
        throw new Error(`Failed to fetch PR info: ${err.message}`);
      },
    );

    const diff = diffResult.match(
      (val) => val,
      (err) => {
        throw new Error(`Failed to fetch PR diff: ${err.message}`);
      },
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

    // Step 2: Call LLM via agent layer to analyze the diff
    const systemPrompt = buildReviewSystemPrompt();
    const userPrompt = buildReviewUserPrompt(prInfo.title, prInfo.body, diff);

    const llmOutput = await callAgent(
      this.processFactory,
      systemPrompt,
      userPrompt,
      model,
      provider,
      cwd,
    );

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
        (err) => {
          throw new Error(`Failed to post review: ${err.message}`);
        },
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
