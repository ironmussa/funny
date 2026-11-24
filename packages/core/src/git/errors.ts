import { processError, internal, type DomainError } from '@funny/shared/errors';

import { ProcessExecutionError } from './process.js';

/**
 * Convert an unknown error into a DomainError.
 * Reused across all git modules to avoid duplicating the same pattern.
 */
export function toDomainError(cause: unknown): DomainError {
  if ((cause as DomainError).type) return cause as DomainError;
  if (cause instanceof ProcessExecutionError) {
    return processError(cause.message, cause.exitCode, cause.stderr);
  }
  return internal(String(cause));
}
