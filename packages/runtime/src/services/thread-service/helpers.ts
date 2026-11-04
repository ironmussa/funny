/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 */

import type { SetupProgressFn } from '@funny/core/ports';
import type { WSEvent } from '@funny/shared';
import { parseReferencedFiles } from '@funny/shared/attachments';

import { log } from '../../lib/logger.js';
import type { FileRef } from '../../utils/file-mentions.js';
import { wsBroker } from '../ws-broker.js';
import { adoptStagedUploads, releaseStagedUploads } from './staged-uploads.js';

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
 * Strip the leading `<referenced-files>...</referenced-files>` block(s) from a
 * prompt so titles, slugs, and previews don't contain raw XML when the user
 * attached inline files via the paperclip.
 */
export function stripReferencedFilesBlock(text: string): string {
  return parseReferencedFiles(text).body.trim();
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

/**
 * Pass-through for a successful request's result that first deletes the
 * staged entries it adopted. Adoption copies, so until this runs a failed
 * request can be retried with the same staged ids.
 */
export function releaseStagedUploadsOnSuccess<T>(params: {
  userId: string;
  stagedUploads?: string[];
}): (value: T) => Promise<T> {
  return async (value) => {
    if (!params.stagedUploads?.length) return value;
    const released = await releaseStagedUploads(params.userId, params.stagedUploads);
    if (released.isErr()) {
      log.warn('Failed to release staged uploads', {
        namespace: 'thread-service',
        error: released.error.message,
      });
    }
    return value;
  };
}

/**
 * Adopt staged uploads into `cwd` and fold them into the file references —
 * from then on they are ordinary uploaded files. A missing/expired staged
 * file fails the whole request (400) and adopts nothing. Pair the request
 * with `releaseStagedUploadsOnSuccess`.
 */
export async function withStagedUploads<
  P extends { userId: string; stagedUploads?: string[]; fileReferences?: FileRef[] },
>(params: P, threadId: string, cwd: string): Promise<P> {
  if (!params.stagedUploads?.length) return params;
  const adopted = await adoptStagedUploads({
    userId: params.userId,
    stagedIds: params.stagedUploads,
    cwd,
    threadId,
  });
  if (adopted.isErr()) {
    const status = adopted.error.type === 'BAD_REQUEST' ? 400 : 500;
    throw new ThreadServiceError(adopted.error.message, status);
  }
  return {
    ...params,
    stagedUploads: undefined,
    fileReferences: [...(params.fileReferences ?? []), ...adopted.value],
  };
}
