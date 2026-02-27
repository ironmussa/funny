import type { DomainError, DomainErrorType } from '@funny/shared/errors';
import type { Context } from 'hono';
import type { Result } from 'neverthrow';

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
    (error) => {
      const body: Record<string, unknown> = { error: error.message };
      if (error.type === 'PROCESS_ERROR') {
        if (error.stderr) body.stderr = error.stderr;
        if (error.exitCode != null) body.exitCode = error.exitCode;
      }
      return c.json(body, STATUS_MAP[error.type] as any);
    },
  );
}
