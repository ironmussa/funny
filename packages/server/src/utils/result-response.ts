import type { Context } from 'hono';
import type { Result } from 'neverthrow';
import type { DomainError, DomainErrorType } from '@funny/shared/errors';

const STATUS_MAP: Record<DomainErrorType, number> = {
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  VALIDATION: 400,
  PROCESS_ERROR: 400,
  CONFLICT: 409,
  INTERNAL: 500,
};

/** Convert a Result<T, DomainError> into a Hono JSON response */
export function resultToResponse<T>(
  c: Context,
  result: Result<T, DomainError>,
  successStatus: number = 200,
) {
  return result.match(
    (value) => c.json(value as any, successStatus as any),
    (error) => c.json({ error: error.message }, STATUS_MAP[error.type] as any),
  );
}
