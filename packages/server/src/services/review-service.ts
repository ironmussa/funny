/**
 * ReviewService — bridges GitHub PR webhooks with @funny/reviewbot.
 *
 * When a PR is opened/synchronize, looks up the matching project by
 * GitHub owner/repo, creates a thread in the UI, runs PRReviewer,
 * and records the result.
 */

import { getRemoteUrl } from '@funny/core/git';
import { PRReviewer } from '@funny/reviewbot';
import { nanoid } from 'nanoid';

import { log } from '../lib/logger.js';
import * as pm from './project-manager.js';
import * as tm from './thread-manager.js';
import { wsBroker } from './ws-broker.js';

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

// ── Helpers ──────────────────────────────────────────────────

/** Extract owner/repo from a GitHub remote URL. */
function parseOwnerRepo(remoteUrl: string): string | null {
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  return null;
}

/**
 * Find a project whose git remote matches the given GitHub owner/repo.
 * Scans all projects (local mode).
 */
async function findProjectByRepo(fullName: string): Promise<{ id: string; path: string } | null> {
  const projects = pm.listProjects('__local__');
  const target = fullName.toLowerCase();

  for (const project of projects) {
    const result = await getRemoteUrl(project.path);
    if (result.isErr() || !result.value) continue;
    const ownerRepo = parseOwnerRepo(result.value);
    if (ownerRepo && ownerRepo.toLowerCase() === target) {
      return { id: project.id, path: project.path };
    }
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────

const reviewer = new PRReviewer();

/**
 * Handle a GitHub pull_request webhook event.
 * Only processes `opened` and `synchronize` actions.
 */
export async function handlePRWebhook(
  payload: PRWebhookPayload,
): Promise<{ threadId: string } | null> {
  const { action, number: prNumber, pull_request: pr, repository: repo } = payload;

  if (action !== 'opened' && action !== 'synchronize') {
    log.info(`Ignoring PR action: ${action}`, { namespace: 'reviewbot' });
    return null;
  }

  // Find matching project
  const project = await findProjectByRepo(repo.full_name);
  if (!project) {
    log.warn(`No project found for repo ${repo.full_name}`, { namespace: 'reviewbot' });
    return null;
  }

  // Create a thread to track the review in the UI
  const threadId = nanoid();
  const title = `Review PR #${prNumber}: ${pr.title}`;
  const now = new Date().toISOString();

  tm.createThread({
    id: threadId,
    projectId: project.id,
    userId: '__local__',
    title,
    mode: 'local',
    provider: 'external',
    permissionMode: 'autoEdit',
    status: 'running',
    stage: 'in_progress',
    model: 'sonnet',
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    source: 'ingest',
    createdBy: 'reviewbot',
    cost: 0,
    createdAt: now,
  });

  // Insert initial user message
  const promptContent = `Review PR #${prNumber}: ${pr.title}\n\n${pr.html_url}`;
  tm.insertMessage({ threadId, role: 'user', content: promptContent });

  wsBroker.emit({
    type: 'thread:created',
    threadId,
    data: { projectId: project.id, title, source: 'ingest' },
  });
  wsBroker.emit({ type: 'agent:status', threadId, data: { status: 'running' } });

  log.info(`Starting review for PR #${prNumber} on ${repo.full_name}`, {
    namespace: 'reviewbot',
    threadId,
  });

  // Run review asynchronously (don't block the webhook response)
  runReview(project.path, prNumber, threadId).catch((err) => {
    log.error(`Review failed for PR #${prNumber}: ${err}`, { namespace: 'reviewbot', threadId });
  });

  return { threadId };
}

/**
 * Run the actual review and update the thread with results.
 */
async function runReview(cwd: string, prNumber: number, threadId: string): Promise<void> {
  const startTime = Date.now();

  try {
    const result = await reviewer.review(cwd, prNumber);

    const now = new Date().toISOString();
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

    const msgId = tm.insertMessage({ threadId, role: 'assistant', content });

    tm.updateThread(threadId, {
      status: 'completed',
      stage: 'done',
      completedAt: now,
    });

    wsBroker.emit({
      type: 'agent:message',
      threadId,
      data: { messageId: msgId, role: 'assistant', content },
    });
    wsBroker.emit({
      type: 'agent:result',
      threadId,
      data: {
        status: 'completed',
        cost: 0,
        duration: Date.now() - startTime,
        result: result.summary,
        stage: 'done',
      },
    });

    log.info(`Review completed for PR #${prNumber}: ${result.status}`, {
      namespace: 'reviewbot',
      threadId,
    });
  } catch (err: any) {
    const now = new Date().toISOString();
    const errorMsg = `Review failed: ${err.message || String(err)}`;

    const msgId = tm.insertMessage({ threadId, role: 'assistant', content: errorMsg });

    tm.updateThread(threadId, {
      status: 'failed',
      completedAt: now,
    });

    wsBroker.emit({
      type: 'agent:message',
      threadId,
      data: { messageId: msgId, role: 'assistant', content: errorMsg },
    });
    wsBroker.emit({
      type: 'agent:result',
      threadId,
      data: {
        status: 'failed',
        cost: 0,
        duration: Date.now() - startTime,
        result: errorMsg,
      },
    });
  }
}
