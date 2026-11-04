/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Upload service: writes user-provided files to the thread's working
 * directory under `.funny/uploads/<threadId>/`. The path returned can
 * then be used as a `fileReference` on a subsequent `sendMessage`.
 *
 * The browser cannot expose absolute paths for drag-dropped files, so
 * for anything larger than the inline tier this endpoint is how the
 * client gets file content into the agent's filesystem.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';

import type { AgentProvider } from '@funny/shared';
import { type DomainError, badRequest, internal } from '@funny/shared/errors';
import { getAttachmentLimits } from '@funny/shared/models';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { requireThreadCwd } from '../../utils/route-helpers.js';

export interface UploadFileParams {
  threadId: string;
  userId: string;
  organizationId?: string | null;
  /** Provider whose limits apply — used to validate `contentBase64` length. */
  provider: AgentProvider;
  /** Original filename from the browser; will be sanitized. */
  filename: string;
  /** File content as base64 — decoded server-side and written to disk. */
  contentBase64: string;
}

export interface UploadFileResult {
  /** Path relative to the thread cwd, suitable as a `fileReference.path`. */
  path: string;
  /** Size of the written file in bytes. */
  size: number;
}

/**
 * Strip path components and unsafe characters from a browser-provided
 * filename. Falls back to "upload" when the result would be empty so we
 * never write to a hidden file or an empty name.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'upload';
}

const UPLOADS_DIR = '.funny/uploads';
const GITIGNORE_CONTENTS = '*\n!.gitignore\n';

/** Decode and size-check base64 upload content against the provider's limits. */
export function decodeUploadContent(
  provider: AgentProvider,
  contentBase64: string,
): Result<Buffer, DomainError> {
  const limits = getAttachmentLimits(provider);
  // Buffer.byteLength on a base64 string is the encoded length, not
  // decoded — decode first to get the real size.
  let buffer: Buffer;
  try {
    buffer = Buffer.from(contentBase64, 'base64');
  } catch {
    return err(badRequest('Invalid base64 content'));
  }
  if (buffer.length === 0) return err(badRequest('Empty file'));
  if (buffer.length > limits.uploadMaxBytes) {
    return err(
      badRequest(
        `File too large (${buffer.length} bytes). Max ${limits.uploadMaxBytes} bytes for provider "${provider}"`,
      ),
    );
  }
  return ok(buffer);
}

/**
 * Resolve `<cwd>/.funny/uploads/<threadId>/<safeName>` and make sure the
 * directory exists (self-gitignored so uploads don't pollute commits).
 * Returns the absolute target path and its cwd-relative form.
 */
export async function prepareThreadUploadPath(
  cwd: string,
  threadId: string,
  safeName: string,
): Promise<Result<{ fullPath: string; relPath: string }, DomainError>> {
  const uploadDir = join(cwd, UPLOADS_DIR, threadId);
  const fullPath = join(uploadDir, safeName);
  // Defense-in-depth: ensure resolved path stays inside cwd even though
  // sanitizeFilename strips traversal sequences.
  if (!resolve(fullPath).startsWith(resolve(cwd) + sep)) {
    return err(badRequest('Upload path escapes thread cwd'));
  }
  await mkdir(uploadDir, { recursive: true });
  await writeFile(join(cwd, '.funny', '.gitignore'), GITIGNORE_CONTENTS);
  return ok({ fullPath, relPath: relative(cwd, fullPath) });
}

export function uploadFile(params: UploadFileParams): ResultAsync<UploadFileResult, DomainError> {
  return ResultAsync.fromPromise(uploadFileImpl(params), (e) => {
    log.error('uploadFile failed', {
      namespace: 'thread-service',
      threadId: params.threadId,
      error: (e as Error).message,
    });
    return internal('Upload failed');
  }).andThen((r) => r);
}

async function uploadFileImpl(
  params: UploadFileParams,
): Promise<Result<UploadFileResult, DomainError>> {
  const cwdResult = await requireThreadCwd(params.threadId, params.userId);
  if (cwdResult.isErr()) return err(cwdResult.error);
  const cwd = cwdResult.value;

  const decoded = decodeUploadContent(params.provider, params.contentBase64);
  if (decoded.isErr()) return err(decoded.error);
  const buffer = decoded.value;

  let target: { fullPath: string; relPath: string };
  try {
    const prepared = await prepareThreadUploadPath(
      cwd,
      params.threadId,
      sanitizeFilename(params.filename),
    );
    if (prepared.isErr()) return err(prepared.error);
    target = prepared.value;
    await writeFile(target.fullPath, buffer);
  } catch (e) {
    log.error('uploadFile write failed', {
      namespace: 'thread-service',
      threadId: params.threadId,
      error: (e as Error).message,
    });
    return err(internal('Failed to write upload'));
  }

  log.info('uploadFile wrote attachment', {
    namespace: 'thread-service',
    threadId: params.threadId,
    path: target.relPath,
    size: buffer.length,
  });
  return ok({ path: target.relPath, size: buffer.length });
}
