import { resolve, isAbsolute } from 'path';
import { access } from 'fs/promises';
import { accessSync } from 'fs';

/**
 * Validates that a path exists and is accessible (async)
 * @throws Error if path is not absolute or doesn't exist
 */
export async function validatePath(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error(`Path must be absolute: ${path}`);
  }

  try {
    await access(path);
    return resolve(path);
  } catch {
    throw new Error(`Path does not exist or is not accessible: ${path}`);
  }
}

/**
 * Validates that a path exists and is accessible (sync)
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
 * Sanitizes a path to prevent directory traversal attacks
 */
export function sanitizePath(basePath: string, userPath: string): string {
  const normalized = resolve(basePath, userPath);

  // Ensure the resolved path is still within the base path
  if (!normalized.startsWith(basePath)) {
    throw new Error('Path traversal detected');
  }

  return normalized;
}
