export type HarnessErrorCode =
  | 'runtime_unavailable'
  | 'unsupported_capability'
  | 'unsupported_sandbox_backend'
  | 'unsupported_tool_exposure'
  | 'tool_validation_failed'
  | 'duplicate_tool'
  | 'agent_execution_failed'
  | 'command_failed'
  | 'approval_unavailable'
  | 'workflow_failed'
  | 'invalid_agent_definition'
  | 'invalid_runtime_request';

export interface HarnessErrorOptions {
  cause?: unknown;
  metadata?: Record<string, unknown>;
}

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly metadata?: Record<string, unknown>;

  constructor(code: HarnessErrorCode, message: string, options: HarnessErrorOptions = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.metadata = options.metadata;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function toHarnessError(
  err: unknown,
  code: HarnessErrorCode = 'agent_execution_failed',
  fallback = 'Harness operation failed',
): HarnessError {
  if (err instanceof HarnessError) return err;
  if (err instanceof Error) {
    return new HarnessError(code, err.message || fallback, { cause: err });
  }
  return new HarnessError(code, String(err || fallback), { cause: err });
}
