import { processError, internal, type DomainError } from '@funny/shared/errors';

import { ProcessExecutionError } from './process.js';

/**
 * Convert an unknown error into a DomainError.
 * Reused across all git modules to avoid duplicating the same pattern.
 */
export function toDomainError(cause: unknown): DomainError {
  // SAFETY: a value with a truthy `type` is taken as a DomainError. The git
  // modules reject with DomainErrors, ProcessExecutionError or plain Errors,
  // and neither Error class has a `type` field.
  const candidate = cause as DomainError;
  if (candidate.type) return candidate;
  if (cause instanceof ProcessExecutionError) {
    return processError(cause.message, cause.exitCode, cause.stderr);
  }
  return internal(String(cause));
}
