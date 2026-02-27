/**
 * Standalone webhook handler for GitHub PR events.
 *
 * Receives GitHub webhooks, runs PRReviewer, and reports results
 * to the funny UI via the Ingest API (@funny/funny-client).
 */

import { FunnyClient } from '@funny/funny-client';
import { nanoid } from 'nanoid';

import { PRReviewer } from './reviewer.js';

// ── Types ────────────────────────────────────────────────────

/** Minimal subset of the GitHub pull_request webhook payload. */
export interface PRWebhookPayload {
  action: string;
  number: number;
  pull_request: {
    title: string;
    html_url: string;
    head: { ref: string };
    base: { ref: string };
  };
  repository: {
    full_name: string; // "owner/repo"
    clone_url: string;
  };
}

export interface RepoMapping {
  /** GitHub owner/repo (e.g. "acme/backend") */
  repo: string;
  /** Local filesystem path to the git checkout */
  path: string;
  /** funny project ID (optional — if omitted, server resolves via repo_full_name) */
  projectId?: string;
}

// ── Config ───────────────────────────────────────────────────

/**
 * Parse REVIEWBOT_REPOS env var into repo mappings.
 *
 * Format: owner/repo:/path/to/repo,owner/repo2:/path/to/repo2
 * Or with optional projectId: owner/repo:/path/to/repo:projectId
 */
export function parseRepoMappings(envValue: string | undefined): RepoMapping[] {
  if (!envValue) return [];

  return envValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // Split on ":" but handle Windows paths (e.g. C:\foo) by splitting from the first ":"
      // after the repo name. Format: owner/repo:/path OR owner/repo:C:\path
      const slashIdx = entry.indexOf('/');
      if (slashIdx === -1) return null;

      // Find the ":" that separates repo from path (skip past "owner/repo")
      const colonAfterRepo = entry.indexOf(':', slashIdx);
      if (colonAfterRepo === -1) return null;

      const repo = entry.slice(0, colonAfterRepo);

      // The rest could be /path or /path:projectId or C:\path:projectId
      const rest = entry.slice(colonAfterRepo + 1);

      // Check if there's a projectId at the end (last segment after ":")
      // Handle Windows drive letters: if rest starts with X: it's a drive letter
      let path: string;
      let projectId: string | undefined;

      // Detect Windows absolute path (e.g. C:\foo or D:/bar)
      const isWindowsPath = /^[A-Za-z]:/.test(rest);
      if (isWindowsPath) {
        // Find ":" that isn't the drive letter colon
        const afterDrive = rest.indexOf(':', 2);
        if (afterDrive !== -1) {
          path = rest.slice(0, afterDrive);
          projectId = rest.slice(afterDrive + 1) || undefined;
        } else {
          path = rest;
        }
      } else {
        const lastColon = rest.lastIndexOf(':');
        if (lastColon > 0) {
          path = rest.slice(0, lastColon);
          projectId = rest.slice(lastColon + 1) || undefined;
        } else {
          path = rest;
        }
      }

      return { repo: repo.toLowerCase(), path, projectId };
    })
    .filter((m): m is RepoMapping => m !== null);
}

// ── Handler ──────────────────────────────────────────────────

const reviewer = new PRReviewer();

export interface WebhookHandlerOptions {
  funnyClient: FunnyClient;
  repoMappings: RepoMapping[];
  acpBaseUrl?: string;
  model?: string;
  log?: (msg: string) => void;
}

/**
 * Handle a GitHub pull_request webhook event.
 * Only processes `opened` and `synchronize` actions.
 */
export async function handlePRWebhook(
  payload: PRWebhookPayload,
  options: WebhookHandlerOptions,
): Promise<{ requestId: string } | null> {
  const { funnyClient, repoMappings, log = console.log } = options;
  const { action, number: prNumber, pull_request: pr, repository: repo } = payload;

  if (action !== 'opened' && action !== 'synchronize') {
    log(`[reviewbot] Ignoring PR action: ${action}`);
    return null;
  }

  // Find repo mapping
  const mapping = repoMappings.find((m) => m.repo === repo.full_name.toLowerCase());
  if (!mapping) {
    log(`[reviewbot] No repo mapping found for ${repo.full_name}`);
    return null;
  }

  const requestId = `reviewbot-${nanoid()}`;
  const title = `Review PR #${prNumber}: ${pr.title}`;
  const promptContent = `Review PR #${prNumber}: ${pr.title}\n\n${pr.html_url}`;

  log(`[reviewbot] Starting review for PR #${prNumber} on ${repo.full_name}`);

  // Create thread in funny (non-blocking — don't fail the webhook if funny is down)
  let threadCreated = false;
  try {
    await funnyClient.accepted(
      requestId,
      {
        title,
        projectId: mapping.projectId,
        repo_full_name: repo.full_name,
        branch: pr.head.ref,
        base_branch: pr.base.ref,
        prompt: promptContent,
      },
      { createdBy: 'reviewbot' },
    );
    threadCreated = true;
  } catch (err: any) {
    log(`[reviewbot] Warning: failed to create thread in funny: ${err.message}`);
  }

  // Run review asynchronously (don't block the webhook response)
  runReview(requestId, mapping.path, prNumber, options, threadCreated).catch((err) => {
    log(`[reviewbot] Review failed for PR #${prNumber}: ${err.message}`);
  });

  return { requestId };
}

async function runReview(
  requestId: string,
  cwd: string,
  prNumber: number,
  options: WebhookHandlerOptions,
  threadCreated: boolean,
): Promise<void> {
  const { funnyClient, log = console.log } = options;
  const startTime = Date.now();

  // Mark as started
  if (threadCreated) {
    try {
      await funnyClient.started(requestId);
    } catch {}
  }

  try {
    const result = await reviewer.review(cwd, prNumber, {
      model: options.model,
      acpBaseUrl: options.acpBaseUrl,
    });

    const duration = Date.now() - startTime;

    // Build the message content (same format as server-side review-service)
    const content =
      `**Review: ${result.status}**\n\n${result.summary}\n\n` +
      (result.findings.length > 0
        ? `### Findings (${result.findings.length})\n\n` +
          result.findings
            .map(
              (f) =>
                `- **[${f.severity}]** ${f.file}${f.line ? `:${f.line}` : ''} — ${f.description}`,
            )
            .join('\n')
        : 'No issues found.');

    // Report to funny
    if (threadCreated) {
      try {
        await funnyClient.message(requestId, content);
        await funnyClient.completed(requestId, {
          cost_usd: 0,
          duration_ms: duration,
          result: result.summary,
        });
      } catch (err: any) {
        log(`[reviewbot] Warning: failed to report result to funny: ${err.message}`);
      }
    }

    log(`[reviewbot] Review completed for PR #${prNumber}: ${result.status} (${duration}ms)`);
  } catch (err: any) {
    const duration = Date.now() - startTime;
    const errorMsg = `Review failed: ${err.message || String(err)}`;

    if (threadCreated) {
      try {
        await funnyClient.failed(requestId, {
          error: errorMsg,
          error_message: errorMsg,
          cost_usd: 0,
          duration_ms: duration,
        });
      } catch {}
    }

    log(`[reviewbot] ${errorMsg}`);
    throw err;
  }
}
