import { processError, internal, type DomainError } from '@funny/shared/errors';

import { ProcessExecutionError } from './process.js';

/**
 * Convert an unknown error into a DomainError.
 * Reused across all git modules to avoid duplicating the same pattern.
 */
export function toDomainError(error: unknown): DomainError {
  // SAFETY: a value with a truthy `type` is taken as a DomainError. The git
  // modules reject with DomainErrors, ProcessExecutionError or plain Errors,
  // and neither Error class has a `type` field.
  const candidate = error as DomainError;
  if (candidate.type) return candidate;
  if (error instanceof ProcessExecutionError) {
    return processError(error.message, error.exitCode, error.stderr);
  }
  return internal(String(error));
}
