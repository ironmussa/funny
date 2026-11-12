/**
 * How a port reports a failure, and how that becomes a tRPC error.
 *
 * Ports answer with the HTTP status the REST route answers today, so a group
 * served both over REST and over tRPC fails the same way on both paths. The
 * client turns the status back into a `DomainError` exactly as it does for
 * REST responses.
 */

import type { DomainError } from '@funny/shared/errors';
import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import type { Result } from 'neverthrow';

export interface ApiFailure {
  status: number;
  message: string;
  /** Text written for the user; replaces the client's generic per-type text. */
  friendlyMessage?: string;
  /** Machine-readable reason the REST route also answers (`{ error, code }`). */
  code?: string;
}

export const failure = (status: number, message: string, friendlyMessage?: string): ApiFailure =>
  friendlyMessage === undefined ? { status, message } : { status, message, friendlyMessage };

const DOMAIN_STATUS: Record<DomainError['type'], number> = {
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  VALIDATION: 400,
  FORBIDDEN: 403,
  CONFLICT: 409,
  PROCESS_ERROR: 500,
  INTERNAL: 500,
};

export function failureFromDomainError(error: DomainError): ApiFailure {
  return failure(DOMAIN_STATUS[error.type], error.message, error.friendlyMessage);
}

const CODE_BY_STATUS: Record<number, TRPC_ERROR_CODE_KEY> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_SUPPORTED',
  408: 'TIMEOUT',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_CONTENT',
  429: 'TOO_MANY_REQUESTS',
  499: 'CLIENT_CLOSED_REQUEST',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

/** Status without a tRPC code of its own: any 4xx is a bad request, anything else internal. */
export function codeForStatus(status: number): TRPC_ERROR_CODE_KEY {
  return (
    CODE_BY_STATUS[status] ??
    (status >= 400 && status < 500 ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR')
  );
}

/** Carries a port failure through tRPC so the error formatter knows it is safe to show. */
export class ApiFailureCause extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
    this.name = 'ApiFailureCause';
  }
}

export function toTrpcError(f: ApiFailure): TRPCError {
  return new TRPCError({
    code: codeForStatus(f.status),
    message: f.message,
    cause: new ApiFailureCause(f),
  });
}

/** A procedure's last step: the port's value, or its failure thrown as a tRPC error. */
export function unwrap<T>(result: Result<T, ApiFailure>): T {
  if (result.isErr()) throw toTrpcError(result.error);
  return result.value;
}
