/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import type { DomainError, DomainErrorType } from '@funny/shared/errors';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Result } from 'neverthrow';

const STATUS_MAP: Record<DomainErrorType, ContentfulStatusCode> = {
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  VALIDATION: 400,
  PROCESS_ERROR: 400,
  CONFLICT: 409,
  INTERNAL: 500,
};

/** HTTP status for a domain error. */
export function errorStatus(error: DomainError): number {
  return STATUS_MAP[error.type];
}

/**
 * The error answer of an operation that recorded its own failed activity
 * (track-funny-actions): `activityRecorded` tells the server not to record a
 * second one. A refusal before the operation ran carries no such flag.
 */
export function recordedFailureResponse(c: Context, error: DomainError) {
  return c.json({ error: error.message, activityRecorded: true }, STATUS_MAP[error.type]);
}

/** Convert a Result<T, DomainError> into a Hono JSON response */
export function resultToResponse<T>(
  c: Context,
  result: Result<T, DomainError>,
  successStatus: number = 200,
) {
  return result.match(
    (value) =>
      // SAFETY: route results are JSON-serializable values (Hono's c.json constraint is not
      // expressible for a generic T), and callers pass 2xx success codes (200 / 201).
      c.json(value as any, successStatus as any),
    (error) => {
      const body: Record<string, unknown> = { error: error.message };
      if (error.type === 'PROCESS_ERROR') {
        if (error.stderr) body.stderr = error.stderr;
        if (error.exitCode != null) body.exitCode = error.exitCode;
      }
      return c.json(body, STATUS_MAP[error.type]);
    },
  );
}
