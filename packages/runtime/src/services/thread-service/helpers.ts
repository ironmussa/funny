/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 */

import type { SetupProgressFn } from '@funny/core/ports';
import type { WSEvent } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { wsBroker } from '../ws-broker.js';

// ── Error type ──────────────────────────────────────────────────

export class ThreadServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
  ) {
    super(message);
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Strip the leading `<referenced-files>...</referenced-files>` block from a
 * prompt so titles, slugs, and previews don't contain raw XML when the user
 * attached inline files via the paperclip.
 */
export function stripReferencedFilesBlock(text: string): string {
  return text.replace(/^\s*<referenced-files>[\s\S]*?<\/referenced-files>\s*/, '').trim();
}

/** Create a URL-safe slug from a title for branch naming */
export function slugifyTitle(title: string, maxLength = 40): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, maxLength)
      .replace(/-$/, '') || 'thread'
  );
}

export function createSetupProgressEmitter(userId: string, threadId: string): SetupProgressFn {
  return (step, label, status, error) => {
    wsBroker.emitToUser(userId, {
      type: 'worktree:setup',
      threadId,
      data: { step, label, status, error },
    });
  };
}

export function emitThreadUpdated(
  userId: string,
  threadId: string,
  data: Record<string, any>,
): void {
  wsBroker.emitToUser(userId, {
    type: 'thread:updated',
    threadId,
    data,
  } as WSEvent);
}

export function emitAgentFailed(userId: string, threadId: string): void {
  const event: WSEvent = {
    type: 'agent:status' as const,
    threadId,
    data: { status: 'failed' },
  };
  if (!userId) {
    log.warn('emitAgentFailed called without userId — dropping', {
      namespace: 'thread-service',
      threadId,
    });
    return;
  }
  wsBroker.emitToUser(userId, event);
}
