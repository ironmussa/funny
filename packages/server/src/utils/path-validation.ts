import { resolve, isAbsolute } from 'path';
import { access } from 'fs/promises';
import { accessSync } from 'fs';
import { ok, err, type Result, ResultAsync } from 'neverthrow';
import { badRequest, forbidden, type DomainError } from '@a-parallel/shared/errors';

/**
 * Validates that a path exists and is accessible (async).
 * Returns ResultAsync<string, DomainError>.
 */
export function validatePath(path: string): ResultAsync<string, DomainError> {
  if (!isAbsolute(path)) {
    return new ResultAsync(Promise.resolve(err(badRequest(`Path must be absolute: ${path}`))));
  }

  return ResultAsync.fromPromise(
    access(path).then(() => resolve(path)),
    () => badRequest(`Path does not exist or is not accessible: ${path}`)
  );
}

/**
 * Validates that a path exists and is accessible (sync).
 * Kept as throw-based for startup operations.
 * @throws Error if path is not absolute or doesn't exist
 */
export function validatePathSync(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`Path must be absolute: ${path}`);
  }

  try {
    accessSync(path);
    return resolve(path);
  } catch {
    throw new Error(`Path does not exist or is not accessible: ${path}`);
  }
}

/**
 * Safely checks if a path exists without throwing
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitizes a path to prevent directory traversal attacks.
 * Returns Result<string, DomainError>.
 */
export function sanitizePath(basePath: string, userPath: string): Result<string, DomainError> {
  const normalized = resolve(basePath, userPath);

  if (!normalized.startsWith(basePath)) {
    return err(forbidden('Path traversal detected'));
  }

  return ok(normalized);
}
