/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Staged uploads: attachments uploaded BEFORE their thread exists (the first
 * message of a new thread). The file is parked in a per-user staging area on
 * the runner and gets a `stagedId`; thread creation then "adopts" it into
 * `<cwd>/.funny/uploads/<threadId>/` — the same place `/threads/:id/upload`
 * writes to — and references it like any other uploaded file.
 *
 *   <DATA_DIR>/uploads-staging/<userId>/<stagedId>/<safeName>   (DATA_DIR = ~/.funny)
 *
 * Isolation: the staging root is keyed by the forwarded `userId`, so a user
 * can only adopt files they staged themselves. Unadopted entries expire after
 * STAGING_TTL_MS and are pruned on the next stage call.
 */

import { randomUUID } from 'crypto';
import { copyFile, cp, mkdir, readdir, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';

import type { AgentProvider } from '@funny/shared';
import { type DomainError, badRequest, internal } from '@funny/shared/errors';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

import { DATA_DIR } from '../../lib/data-dir.js';
import { log } from '../../lib/logger.js';
import type { FileRef } from '../../utils/file-mentions.js';
import { STAGED_ID_RE } from '../../validation/schemas.js';
import { decodeUploadContent, prepareThreadUploadPath, sanitizeFilename } from './upload.js';

const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const USER_ID_RE = /^[A-Za-z0-9_-]+$/;

function stagingRootFor(userId: string): string {
  // Same path-traversal invariant as scratchPathFor: the userId becomes a
  // directory name, so it must be a plain id.
  if (!USER_ID_RE.test(userId)) {
    throw new Error(`stagingRootFor: userId failed shape check (got: ${JSON.stringify(userId)})`);
  }
  return join(DATA_DIR, 'uploads-staging', userId);
}

export interface StageUploadParams {
  userId: string;
  provider: AgentProvider;
  filename: string;
  contentBase64: string;
}

export interface StagedUpload {
  stagedId: string;
  /** Sanitized filename the file will keep once adopted. */
  name: string;
  size: number;
}

/** Remove the user's staged entries older than STAGING_TTL_MS. Best-effort. */
async function pruneExpired(root: string): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const cutoff = Date.now() - STAGING_TTL_MS;
  await Promise.all(
    entries.map(async (entry) => {
      const dir = join(root, entry);
      const info = await stat(dir).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
    }),
  );
}

async function stageUploadImpl(
  params: StageUploadParams,
): Promise<Result<StagedUpload, DomainError>> {
  const decoded = decodeUploadContent(params.provider, params.contentBase64);
  if (decoded.isErr()) return err(decoded.error);

  const root = stagingRootFor(params.userId);
  await pruneExpired(root);

  const stagedId = randomUUID();
  const name = sanitizeFilename(params.filename);
  const dir = join(root, stagedId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), decoded.value);

  log.info('stageUpload parked attachment', {
    namespace: 'thread-service',
    userId: params.userId,
    stagedId,
    size: decoded.value.length,
  });
  return ok({ stagedId, name, size: decoded.value.length });
}

export function stageUpload(params: StageUploadParams): ResultAsync<StagedUpload, DomainError> {
  return ResultAsync.fromPromise(stageUploadImpl(params), (e) => {
    log.error('stageUpload failed', {
      namespace: 'thread-service',
      userId: params.userId,
      error: (e as Error).message,
    });
    return internal('Upload failed');
  }).andThen((r) => r);
}

/** The single file inside a staged entry, or null when missing/expired. */
async function stagedFileOf(root: string, stagedId: string): Promise<string | null> {
  // Refuse anything but a `randomUUID()` before touching disk.
  if (!STAGED_ID_RE.test(stagedId)) return null;
  const files = await readdir(join(root, stagedId)).catch(() => [] as string[]);
  return files.length === 1 ? files[0] : null;
}

export interface AdoptStagedUploadsParams {
  userId: string;
  stagedIds: readonly string[];
  /** Directory the file references will be relative to. */
  cwd: string;
  threadId: string;
}

async function adoptStagedUploadsImpl(
  params: AdoptStagedUploadsParams,
): Promise<Result<FileRef[], DomainError>> {
  if (params.stagedIds.length === 0) return ok([]);
  const root = stagingRootFor(params.userId);

  // Validate every entry first so a missing one adopts nothing.
  const found: { stagedId: string; name: string }[] = [];
  for (const stagedId of params.stagedIds) {
    const name = await stagedFileOf(root, stagedId);
    if (!name) {
      return err(badRequest('An attached file expired or was not found. Attach it again.'));
    }
    found.push({ stagedId, name });
  }

  const refs: FileRef[] = [];
  for (const { stagedId, name } of found) {
    const target = await prepareThreadUploadPath(params.cwd, params.threadId, name);
    if (target.isErr()) return err(target.error);
    // Copy, not move: if the request fails after this point the client keeps
    // the staged chip and can retry. The entry is released on success
    // (`releaseStagedUploads`) or expires with the TTL.
    await copyFile(join(root, stagedId, name), target.value.fullPath);
    refs.push({ path: target.value.relPath });
  }

  log.info('adoptStagedUploads copied attachments', {
    namespace: 'thread-service',
    threadId: params.threadId,
    count: refs.length,
  });
  return ok(refs);
}

/**
 * Copy staged files into `<cwd>/.funny/uploads/<threadId>/` and return their
 * cwd-relative file references. Fails (adopting nothing) when any id is
 * unknown, expired or belongs to another user.
 */
export function adoptStagedUploads(
  params: AdoptStagedUploadsParams,
): ResultAsync<FileRef[], DomainError> {
  return ResultAsync.fromPromise(adoptStagedUploadsImpl(params), (e) => {
    log.error('adoptStagedUploads failed', {
      namespace: 'thread-service',
      threadId: params.threadId,
      error: (e as Error).message,
    });
    return internal('Failed to attach uploaded files');
  }).andThen((r) => r);
}

/**
 * Delete staged entries once the request that adopted them succeeded.
 * Best-effort: whatever is left behind expires with the TTL.
 */
export function releaseStagedUploads(
  userId: string,
  stagedIds: readonly string[],
): ResultAsync<void, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const root = stagingRootFor(userId);
      await Promise.all(
        stagedIds
          .filter((id) => STAGED_ID_RE.test(id))
          .map((id) => rm(join(root, id), { recursive: true, force: true })),
      );
    })(),
    (e) => internal(`Failed to release staged uploads: ${(e as Error).message}`),
  );
}

/**
 * Copy a thread's uploads from one checkout to another — a new worktree is
 * created after the files were adopted into the project checkout, and
 * `.funny/` is gitignored so the worktree does not get them otherwise.
 */
export function copyThreadUploads(
  fromCwd: string,
  toCwd: string,
  threadId: string,
): ResultAsync<void, DomainError> {
  const rel = join('.funny', 'uploads', threadId);
  return ResultAsync.fromPromise(
    (async () => {
      const source = join(fromCwd, rel);
      if (!(await stat(source).catch(() => null))) return;
      // Called for its mkdir + .gitignore side effects on the target checkout.
      const prepared = await prepareThreadUploadPath(toCwd, threadId, 'placeholder');
      if (prepared.isErr()) throw new Error(prepared.error.message);
      await cp(source, join(toCwd, rel), { recursive: true });
    })(),
    (e) => internal(`Failed to copy uploads: ${(e as Error).message}`),
  );
}
